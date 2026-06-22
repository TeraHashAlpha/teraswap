/**
 * POST /api/orders — Create a new autonomous order
 * GET  /api/orders?wallet=0x... — List orders for a wallet
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { recoverTypedDataAddress, zeroHash } from 'viem'
import { getOrderExecutor, getOrderExecutorDomain, MIN_ORDER_AMOUNT } from '@/lib/order-engine/config'
import { getDcaFreezeState } from '@/lib/dca-freeze'
import { NATIVE_ETH } from '@/lib/constants'

// [CHORE-DCA-WETH-INPUT] Conditional order types whose INPUT must be an ERC-20 (never native ETH).
const CONDITIONAL_ORDER_TYPES = new Set(['limit', 'stop_loss', 'dca'])

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const MAX_EXPIRY_DAYS = 90
const MAX_ACTIVE_ORDERS = 20
// [API-02] MIN_ORDER_AMOUNT (= contract's 10_000) is now imported from order-engine/config.ts —
// [CHORE-DCA-PRELAUNCH-FIXES] single source of truth shared with the client pre-sign guard.

const ORDER_TYPES = {
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'orderType', type: 'uint8' },
    { name: 'condition', type: 'uint8' },
    { name: 'targetPrice', type: 'uint256' },
    { name: 'priceFeed', type: 'address' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'router', type: 'address' },
    { name: 'routerDataHash', type: 'bytes32' },  // [C-01]
    { name: 'dcaInterval', type: 'uint256' },
    { name: 'dcaTotal', type: 'uint256' },
  ],
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

// ── POST — Create order ────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const supabase = getSupabase()
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
    }

    // Validate addresses
    for (const field of ['wallet', 'tokenIn', 'tokenOut', 'router'] as const) {
      if (!ADDRESS_RE.test(body[field] ?? '')) {
        return NextResponse.json({ error: `Invalid ${field} address` }, { status: 400 })
      }
    }

    // [CHORE-DCA-WETH-INPUT] Fail-closed: a conditional order's INPUT (spend token) must be an
    // ERC-20 (WETH), never native ETH. The OrderExecutor pulls tokenIn via Permit2/transferFrom,
    // which the native sentinel can't satisfy, so reject it here (case-insensitive — the sentinel
    // is EIP-55 mixed case). tokenOut may still be native ETH (the contract unwraps WETH→ETH on
    // delivery). Placed after the address loop (tokenIn is now a known-valid hex string) and before
    // any signature/DB work. Instant-swap is a different route and is unaffected.
    if (
      CONDITIONAL_ORDER_TYPES.has(body.orderType) &&
      typeof body.tokenIn === 'string' &&
      body.tokenIn.toLowerCase() === NATIVE_ETH.toLowerCase()
    ) {
      return NextResponse.json(
        { error: 'Use WETH (not native ETH) as the order input' },
        { status: 400 },
      )
    }

    if (!body.signature || !body.orderHash) {
      return NextResponse.json({ error: 'Missing signature or orderHash' }, { status: 400 })
    }
    // [M-01] Validate signature format before passing to viem
    if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
      return NextResponse.json({ error: 'Invalid signature format' }, { status: 400 })
    }
    if (!body.amountIn || body.amountIn === '0') {
      return NextResponse.json({ error: 'amountIn must be positive' }, { status: 400 })
    }

    // [API-02] Validate amountIn >= contract MIN_ORDER_AMOUNT
    try {
      if (BigInt(body.amountIn) < MIN_ORDER_AMOUNT) {
        return NextResponse.json(
          { error: 'Order amount below minimum (10,000 wei)', minimum: '10000' },
          { status: 400 },
        )
      }
    } catch {
      return NextResponse.json(
        { error: 'Invalid amountIn: must be a numeric string' },
        { status: 400 },
      )
    }

    // Validate expiry
    const now = Math.floor(Date.now() / 1000)
    if (body.expiry <= now) {
      return NextResponse.json({ error: 'Expiry must be in the future' }, { status: 400 })
    }
    if (body.expiry > now + MAX_EXPIRY_DAYS * 86400) {
      return NextResponse.json({ error: `Expiry cannot exceed ${MAX_EXPIRY_DAYS} days` }, { status: 400 })
    }

    // Validate DCA fields
    if (body.orderType === 'dca') {
      if (!body.dcaInterval || body.dcaInterval < 60) {
        return NextResponse.json({ error: 'DCA interval must be ≥ 60s' }, { status: 400 })
      }
      if (!body.dcaTotal || body.dcaTotal < 2 || body.dcaTotal > 365) {
        return NextResponse.json({ error: 'DCA must have 2-365 executions' }, { status: 400 })
      }
      // [API-02] Validate individual DCA chunk >= MIN_ORDER_AMOUNT
      const chunkAmount = BigInt(body.amountIn) / BigInt(body.dcaTotal)
      if (chunkAmount < MIN_ORDER_AMOUNT) {
        return NextResponse.json(
          {
            error: 'DCA chunk amount below minimum (10,000 wei). Increase total amount or reduce number of executions.',
            minimum: '10000',
            chunkAmount: chunkAmount.toString(),
          },
          { status: 400 },
        )
      }

      // [DCA-FREEZE] Circuit-breaker gate — ONLY for new DCA orders. When the
      // breaker is frozen we refuse to CREATE new DCA positions, but existing
      // orders are untouched (no update/delete here) and cancellation stays
      // available (the cancel route never reads this flag). Fail-open: any read
      // error ⇒ getDcaFreezeState() returns { frozen:false } and we proceed.
      // Non-DCA orders (limit/stop_loss) never reach this branch — byte-identical.
      const fz = await getDcaFreezeState()
      if (fz.frozen) {
        return NextResponse.json(
          {
            error:
              'New DCA orders are temporarily paused' +
              (fz.reason ? ': ' + fz.reason : '') +
              '. Existing orders are unaffected and you can still cancel them.',
            frozen: true,
          },
          { status: 403 },
        )
      }
    }

    if (body.tokenIn.toLowerCase() === body.tokenOut.toLowerCase()) {
      return NextResponse.json({ error: 'tokenIn and tokenOut must differ' }, { status: 400 })
    }

    // Validate priceFeed — must be a valid address.
    // DCA orders may use address(0) to skip price condition (execute at any price on schedule).
    const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
    if (!body.priceFeed || !body.priceFeed.startsWith('0x') || body.priceFeed.length !== 42) {
      return NextResponse.json({ error: 'Invalid or missing Chainlink price feed address' }, { status: 400 })
    }
    // Non-DCA orders must have a real price feed (not zero address)
    if (body.orderType !== 'dca' && body.priceFeed === ZERO_ADDR) {
      return NextResponse.json({ error: 'Limit/Stop-Loss orders require a Chainlink price feed' }, { status: 400 })
    }

    // [CHORE-ORDER-API-CHAIN-AWARE] Derive the verification chain from the SIGNED order (body.chainId)
    // — the SAME chainId the frontend put in the EIP-712 domain when it signed (getOrderExecutorDomain
    // on the client). The server no longer reads process.env.CHAIN_ID for verification, so a single
    // deployment serves every wired chain. Validate it's an integer, then FAIL-CLOSED before any
    // signature verification when the chain has no real OrderExecutor (mirrors the cancel route's
    // body.chainId precedent in [id]/route.ts). The executor address is resolved server-side from the
    // allowlist (getOrderExecutor), NEVER from the body — a forged chainId either resolves to null
    // (400 here) or to a real executor whose domain the signature won't recover under ('Signature
    // mismatch'). Mainnet (chainId 1) is byte-identical: getOrderExecutorDomain(1) === the previous
    // hand-assembled domain field-for-field.
    const chainId = body.chainId
    if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
      return NextResponse.json({ error: 'Invalid chainId' }, { status: 400 })
    }
    const executorAddress = getOrderExecutor(chainId)
    if (!executorAddress) {
      return NextResponse.json(
        { error: `Conditional orders are not yet available on chain ${chainId}` },
        { status: 400 },
      )
    }
    {
      try {
        const domain = getOrderExecutorDomain(chainId)
        const orderTypeEnum = body.orderType === 'limit' ? 0 : body.orderType === 'stop_loss' ? 1 : 2
        const conditionEnum = body.priceCondition === 'above' ? 0 : 1

        const message = {
          owner: body.wallet, tokenIn: body.tokenIn, tokenOut: body.tokenOut,
          amountIn: body.amountIn, minAmountOut: body.minAmountOut,
          orderType: orderTypeEnum, condition: conditionEnum,
          targetPrice: body.targetPrice, priceFeed: body.priceFeed,
          expiry: body.expiry, nonce: body.nonce, router: body.router,
          routerDataHash: body.routerDataHash ?? zeroHash,  // [C-01]
          dcaInterval: body.dcaInterval ?? 0, dcaTotal: body.dcaTotal ?? 1,
        }

        const recovered = await recoverTypedDataAddress({
          domain,
          types: ORDER_TYPES,
          primaryType: 'Order' as const,
          message,
          signature: body.signature as `0x${string}`,
        })
        if (recovered.toLowerCase() !== body.wallet.toLowerCase()) {
          return NextResponse.json({ error: 'Signature mismatch' }, { status: 400 })
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'unknown'
        return NextResponse.json({ error: `Signature verification failed: ${msg}` }, { status: 400 })
      }
    }

    // [Audit M-07] Cross-validate order_data blob against top-level fields
    if (body.orderData) {
      const od = body.orderData
      const mismatchFields: string[] = []
      if (od.owner?.toLowerCase() !== body.wallet?.toLowerCase()) mismatchFields.push('owner/wallet')
      if (od.tokenIn?.toLowerCase() !== body.tokenIn?.toLowerCase()) mismatchFields.push('tokenIn')
      if (od.tokenOut?.toLowerCase() !== body.tokenOut?.toLowerCase()) mismatchFields.push('tokenOut')
      if (String(od.amountIn) !== String(body.amountIn)) mismatchFields.push('amountIn')
      if (String(od.minAmountOut) !== String(body.minAmountOut)) mismatchFields.push('minAmountOut')
      if (od.router?.toLowerCase() !== body.router?.toLowerCase()) mismatchFields.push('router')
      if (mismatchFields.length > 0) {
        return NextResponse.json(
          { error: `order_data mismatch on fields: ${mismatchFields.join(', ')}` },
          { status: 400 },
        )
      }
    }

    // Rate limiting
    const { data: canCreate } = await supabase.rpc('check_order_rate_limit', {
      p_wallet: body.wallet.toLowerCase(),
      p_max_orders: MAX_ACTIVE_ORDERS,
      p_window_minutes: 60,
    })
    if (canCreate === false) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    // Insert
    const { data, error } = await supabase
      .from('orders')
      .insert({
        wallet: body.wallet.toLowerCase(),
        order_type: body.orderType,
        token_in: body.tokenIn.toLowerCase(),
        token_in_symbol: body.tokenInSymbol,
        token_out: body.tokenOut.toLowerCase(),
        token_out_symbol: body.tokenOutSymbol,
        amount_in: body.amountIn,
        min_amount_out: body.minAmountOut,
        target_price: body.targetPrice,
        price_feed: body.priceFeed?.toLowerCase() || '',
        price_condition: body.priceCondition,
        expiry: body.expiry,
        nonce: body.nonce,
        signature: body.signature,
        order_hash: body.orderHash,
        dca_interval: body.dcaInterval ?? 0,
        dca_total: body.dcaTotal ?? 1,
        router: body.router.toLowerCase(),
        order_data: body.orderData ?? null,
        token_in_decimals: body.tokenInDecimals ?? 18,
        token_out_decimals: body.tokenOutDecimals ?? 18,
        // [CHORE-ORDER-API-CHAIN-AWARE] Persist the VERIFIED signed chainId (not process.env.CHAIN_ID)
        // so a Base order stores chain_id=8453 and mainnet stores chain_id=1 (= today's DEFAULT,
        // byte-identical). The keeper scopes its active-orders query by this column per chain.
        chain_id: chainId,
        status: 'active',
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'Order already exists (duplicate hash)' }, { status: 409 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ order: data }, { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ── GET — List user's orders ───────────────────────────────
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get('wallet')
  const status = req.nextUrl.searchParams.get('status')

  if (!wallet || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: 'Invalid or missing wallet' }, { status: 400 })
  }

  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ orders: [] })
  }

  let query = supabase
    .from('orders')
    .select('*')
    .eq('wallet', wallet.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(50)

  if (status) {
    // Support comma-separated statuses: ?status=active,executing,partially_filled
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length === 1) {
      query = query.eq('status', statuses[0])
    } else if (statuses.length > 1) {
      query = query.in('status', statuses)
    }
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ orders: [], error: error.message })
  return NextResponse.json({ orders: data ?? [] })
}
