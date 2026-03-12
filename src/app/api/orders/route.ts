/**
 * POST /api/orders — Create a new autonomous order
 * GET  /api/orders?wallet=0x... — List orders for a wallet
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { ethers } from 'ethers'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const MAX_EXPIRY_DAYS = 90
const MAX_ACTIVE_ORDERS = 20

const EIP712_DOMAIN = { name: 'TeraSwapOrderExecutor', version: '2' }
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

    if (!body.signature || !body.orderHash) {
      return NextResponse.json({ error: 'Missing signature or orderHash' }, { status: 400 })
    }
    if (!body.amountIn || body.amountIn === '0') {
      return NextResponse.json({ error: 'amountIn must be positive' }, { status: 400 })
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
    }

    if (body.tokenIn.toLowerCase() === body.tokenOut.toLowerCase()) {
      return NextResponse.json({ error: 'tokenIn and tokenOut must differ' }, { status: 400 })
    }

    // Validate priceFeed — must be a valid non-zero address
    const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
    if (!body.priceFeed || body.priceFeed === ZERO_ADDR || !body.priceFeed.startsWith('0x') || body.priceFeed.length !== 42) {
      return NextResponse.json({ error: 'Invalid or missing Chainlink price feed address' }, { status: 400 })
    }

    // [BUGFIX] Signature verification is MANDATORY — reject if executor address not configured
    const executorAddress = process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS || process.env.ORDER_EXECUTOR_ADDRESS
    if (!executorAddress) {
      return NextResponse.json(
        { error: 'Order executor not configured — cannot verify signatures' },
        { status: 503 },
      )
    }
    {
      try {
        const chainId = parseInt(process.env.CHAIN_ID || '1', 10)
        const domain = { ...EIP712_DOMAIN, chainId, verifyingContract: executorAddress }
        const orderTypeEnum = body.orderType === 'limit' ? 0 : body.orderType === 'stop_loss' ? 1 : 2
        const conditionEnum = body.priceCondition === 'above' ? 0 : 1

        const message = {
          owner: body.wallet, tokenIn: body.tokenIn, tokenOut: body.tokenOut,
          amountIn: body.amountIn, minAmountOut: body.minAmountOut,
          orderType: orderTypeEnum, condition: conditionEnum,
          targetPrice: body.targetPrice, priceFeed: body.priceFeed,
          expiry: body.expiry, nonce: body.nonce, router: body.router,
          routerDataHash: body.routerDataHash ?? ethers.ZeroHash,  // [C-01]
          dcaInterval: body.dcaInterval ?? 0, dcaTotal: body.dcaTotal ?? 1,
        }

        const recovered = ethers.verifyTypedData(domain, ORDER_TYPES, message, body.signature)
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
