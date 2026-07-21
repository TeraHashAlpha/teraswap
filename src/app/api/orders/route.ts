/**
 * POST /api/orders — Create a new autonomous order
 * GET  /api/orders?wallet=0x... — List orders for a wallet
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { recoverTypedDataAddress, zeroHash } from 'viem'
import { getOrderExecutor, getOrderExecutorDomain, MIN_ORDER_AMOUNT,
  // [SPRINT-V3-P2] v3 — fail-closed while getOrderExecutorV3(chainId) is null.
  getOrderExecutorV3, getOrderExecutorV3Domain,
  // [SPRINT-P1B] Served-router assertion for pinned non-DCA routes (never widens the whitelist).
  isWhitelistedRouter } from '@/lib/order-engine/config'
// [SPRINT-P1B / ADR-014 (a)] Pinned-calldata hash verification + the SL deferral reason.
import { verifyRouterDataHash } from '@/lib/order-engine/canonical-route'
import { STOP_LOSS_DEFERRED_REASON } from '@/lib/order-engine/limit-launch'
import { ORDER_EIP712_TYPES, ORDER_V3_EIP712_TYPES, MAX_ORDER_SLIPPAGE_BPS } from '@/lib/order-engine/types'
import { getDcaMinChunkUsd } from '@/lib/order-engine/dca-custom'
import {
  verifyOrdersReadAccess,
  PUBLIC_ORDER_STATUSES,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
} from '@/lib/order-engine/read-auth'
import { getDcaFreezeState } from '@/lib/dca-freeze'
import { checkRateLimit, ORDER_CREATE_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { bodySizeGuard, clientIp } from '@/lib/body-limit'
import { NATIVE_ETH } from '@/lib/constants'
import { fetchDefiLlamaPrice } from '@/lib/defillama'
import { computeTokenAmountUsd, fetchErc20Decimals } from '@/lib/chainlink'
import { getChainConfig } from '@/lib/chains/registry'

// [CHORE-DCA-WETH-INPUT] Conditional order types whose INPUT must be an ERC-20 (never native ETH).
const CONDITIONAL_ORDER_TYPES = new Set(['limit', 'stop_loss', 'dca'])

// ── [SPRINT-P1B-SEC] Strict discriminator parsing (CodeQL: user-controlled bypass) ───────────
// The order type and price condition are the discriminators every policy gate in this route keys
// on (Stop-Loss deferral, DCA validation, the pinned-route requirement, the native-ETH gate).
// They previously reached those gates as RAW request strings, while the EIP-712 message derived
// its enums from the same strings through a LOSSY, silently-defaulting mapping:
//
//     orderTypeEnum = body.orderType === 'limit' ? 0 : body.orderType === 'stop_loss' ? 1 : 2
//     conditionEnum = body.priceCondition === 'above' ? 0 : 1
//
// Anything unrecognised fell through to DCA / BELOW instead of being rejected. That let a caller
// desync the POLICY view from the SIGNED view with nothing more than different casing — e.g.
// `priceCondition: 'BELOW'` failed the `=== 'below'` Stop-Loss gate while still encoding
// condition = 1 (BELOW) into the signed struct, producing a real, executable on-chain stop-loss
// that the deferral policy was supposed to refuse.
//
// These maps are total-with-rejection: an unknown value yields undefined and is refused up front,
// so the string→enum relation is bijective and the policy view can no longer disagree with the
// signed view. Map (not an object literal) so inherited keys like `constructor` cannot match.
const ORDER_TYPE_ENUM = new Map<string, 0 | 1 | 2>([['limit', 0], ['stop_loss', 1], ['dca', 2]])
const PRICE_CONDITION_ENUM = new Map<string, 0 | 1>([['above', 0], ['below', 1]])

/** Canonical enum values — the ONLY thing policy gates may branch on. */
const ORDER_TYPE_STOP_LOSS = 1
const ORDER_TYPE_DCA = 2
const CONDITION_BELOW = 1

/** Inverse maps, so the persisted row is derived from the enum rather than the raw request text. */
const ORDER_TYPE_LABEL = ['limit', 'stop_loss', 'dca'] as const
const PRICE_CONDITION_LABEL = ['above', 'below'] as const

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const MAX_EXPIRY_DAYS = 90
const MAX_ACTIVE_ORDERS = 20
// [API-02] MIN_ORDER_AMOUNT (= contract's 10_000) is now imported from order-engine/config.ts —
// [CHORE-DCA-PRELAUNCH-FIXES] single source of truth shared with the client pre-sign guard.

// [CHORE-EIP712-ORDER-TYPES-DEDUP] The Order schema is single-sourced from
// order-engine/types.ts (ORDER_EIP712_TYPES) — the SAME object the client
// signs with in useOrderEngine. It was previously re-declared inline here
// (byte-identical, proven by digest comparison at dedup time); a one-sided
// edit would have silently broken recoverTypedDataAddress with a 400
// "Signature mismatch". Schema + digest are locked by
// src/lib/order-engine/types.test.ts.

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

// ── POST — Create order ────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    // [W6-L-01] Oversized body → 413 before any read (header-only check).
    const tooLarge = bodySizeGuard(req)
    if (tooLarge) return tooLarge

    // [W6-M-02] Per-IP creation limit BEFORE body parse / signature work.
    // Complements the per-wallet DB limit below (self-signed spam needs
    // neither a new wallet nor a new signature to hammer this route).
    const rate = await checkRateLimit(
      `orders:${clientIp(req)}`,
      ORDER_CREATE_RATE_LIMIT.limit,
      ORDER_CREATE_RATE_LIMIT.windowMs,
    )
    if (!rate.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Try again in 60 seconds.' },
        { status: 429, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(rate.resetAt) } },
      )
    }

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

    // ── [SPRINT-P1B-SEC] Parse the discriminators STRICTLY, before any gate reads them ────────
    // Everything downstream branches on these enums, never on the raw strings, so a request field
    // can no longer steer a policy decision away from what the signature will bind.
    if (typeof body.orderType !== 'string' || !ORDER_TYPE_ENUM.has(body.orderType)) {
      return NextResponse.json(
        { error: `Invalid orderType — must be one of: ${[...ORDER_TYPE_ENUM.keys()].join(', ')}` },
        { status: 400 },
      )
    }
    if (typeof body.priceCondition !== 'string' || !PRICE_CONDITION_ENUM.has(body.priceCondition)) {
      return NextResponse.json(
        { error: `Invalid priceCondition — must be one of: ${[...PRICE_CONDITION_ENUM.keys()].join(', ')}` },
        { status: 400 },
      )
    }
    const orderTypeEnum = ORDER_TYPE_ENUM.get(body.orderType)!
    const conditionEnum = PRICE_CONDITION_ENUM.get(body.priceCondition)!
    // Canonical spellings, derived FROM the enum — never the caller's original casing.
    const orderTypeLabel = ORDER_TYPE_LABEL[orderTypeEnum]
    const priceConditionLabel = PRICE_CONDITION_LABEL[conditionEnum]

    // [CHORE-DCA-WETH-INPUT] Fail-closed: a conditional order's INPUT (spend token) must be an
    // ERC-20 (WETH), never native ETH. The OrderExecutor pulls tokenIn via Permit2/transferFrom,
    // which the native sentinel can't satisfy, so reject it here (case-insensitive — the sentinel
    // is EIP-55 mixed case). tokenOut may still be native ETH (the contract unwraps WETH→ETH on
    // delivery). Placed after the address loop (tokenIn is now a known-valid hex string) and before
    // any signature/DB work. Instant-swap is a different route and is unaffected.
    if (
      CONDITIONAL_ORDER_TYPES.has(orderTypeLabel) &&
      typeof body.tokenIn === 'string' &&
      body.tokenIn.toLowerCase() === NATIVE_ETH.toLowerCase()
    ) {
      return NextResponse.json(
        { error: 'Use WETH (not native ETH) as the order input' },
        { status: 400 },
      )
    }

    // codeql[js/user-controlled-bypass] — presence precondition only; the security decision is the
    // ECDSA recovery at the EIP-712 block below (recovered address must equal body.wallet).
    if (!body.signature || !body.orderHash) {
      return NextResponse.json({ error: 'Missing signature or orderHash' }, { status: 400 })
    }
    // [M-01] Validate signature format before passing to viem
    if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
      return NextResponse.json({ error: 'Invalid signature format' }, { status: 400 })
    }
    // codeql[js/user-controlled-bypass] — amountIn is bound by the EIP-712 signature and re-enforced
    // on-chain (MIN_ORDER_AMOUNT / OrderTooSmall); this is a fast-fail, not the security boundary.
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
    // [SPRINT-P1B-SEC] Keyed on the canonical enum: a raw-string compare here let `orderType:'DCA'`
    // skip the interval/chunk minimums AND the freeze circuit-breaker while still encoding a real
    // DCA (enum 2) into the signed struct.
    if (orderTypeEnum === ORDER_TYPE_DCA) {
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
    // codeql[js/user-controlled-bypass] — format check on a signature-bound field; the binding
    // decision is the contract's own _checkPriceCondition (staleness, round integrity, feed config).
    if (!body.priceFeed || !body.priceFeed.startsWith('0x') || body.priceFeed.length !== 42) {
      return NextResponse.json({ error: 'Invalid or missing Chainlink price feed address' }, { status: 400 })
    }
    // Non-DCA orders must have a real price feed (not zero address)
    if (orderTypeEnum !== ORDER_TYPE_DCA && body.priceFeed === ZERO_ADDR) {
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

    // [SPRINT-V3-P2 / ADR-013 §1] A v3 order is one the client signed with maxSlippageBps set
    // (the frontend only sets it once getOrderExecutorV3(chainId) is configured — see
    // useOrderEngine.ts). Server-side detection is INDEPENDENT of client intent: presence of a
    // numeric top-level body.maxSlippageBps is the sole discriminator, and everything downstream
    // (executor resolution, domain, typed-data schema, extra validation) branches on it. Never
    // trust the client's claim that this is/isn't v3 beyond this one typed field — the recovered
    // signer check below is what actually proves the order was signed under the claimed schema.
    const isV3Order = typeof body.maxSlippageBps === 'number'

    if (isV3Order) {
      // [ADR-013 §1/N3] Mirrors the contract's immutable MAX_ORDER_SLIPPAGE_BPS cap — reject
      // absent/zero/out-of-range before any signature work (closes I-01 off-chain).
      if (!Number.isFinite(body.maxSlippageBps) || body.maxSlippageBps <= 0 || body.maxSlippageBps > MAX_ORDER_SLIPPAGE_BPS) {
        return NextResponse.json(
          { error: `maxSlippageBps must be > 0 and <= ${MAX_ORDER_SLIPPAGE_BPS}` },
          { status: 400 },
        )
      }
    }

    // [SPRINT-V3-P2] Executor resolution branches on isV3Order — a v3 order on a chain with no
    // v3 executor configured is rejected here, fail-closed, exactly like the v2 unwired-chain
    // case below. A v2 order is completely unaffected (identical to before this sprint).
    const executorAddress = isV3Order ? getOrderExecutorV3(chainId) : getOrderExecutor(chainId)
    if (!executorAddress) {
      return NextResponse.json(
        { error: `${isV3Order ? 'v3 c' : 'C'}onditional orders are not yet available on chain ${chainId}` },
        { status: 400 },
      )
    }
    {
      try {
        const domain = isV3Order ? getOrderExecutorV3Domain(chainId) : getOrderExecutorDomain(chainId)
        // [SPRINT-P1B-SEC] Enums come from the strict parse above — the same values every policy
        // gate uses. Previously re-derived here by a lossy mapping, which is what allowed the
        // policy view and the signed view to disagree.
        const message = {
          owner: body.wallet, tokenIn: body.tokenIn, tokenOut: body.tokenOut,
          amountIn: body.amountIn, minAmountOut: body.minAmountOut,
          // [ADR-013 §1] Only present in the v3 schema — omitted entirely for a v2 message so the
          // v2 typed-data encoding stays byte-identical to before this sprint.
          ...(isV3Order ? { maxSlippageBps: body.maxSlippageBps } : {}),
          orderType: orderTypeEnum, condition: conditionEnum,
          targetPrice: body.targetPrice, priceFeed: body.priceFeed,
          expiry: body.expiry, nonce: body.nonce, router: body.router,
          routerDataHash: body.routerDataHash ?? zeroHash,  // [C-01]
          dcaInterval: body.dcaInterval ?? 0, dcaTotal: body.dcaTotal ?? 1,
        }

        const recovered = await recoverTypedDataAddress({
          domain,
          types: isV3Order ? ORDER_V3_EIP712_TYPES : ORDER_EIP712_TYPES,
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

    // ── [SPRINT-P1B / ADR-014] Stop-Loss is deferred to the v4 executor ──────────────────────
    // Owner decision 2026-07-22. Under ADR-014 option (a) the route is pinned at signing, so a
    // dislocated pool at trigger makes the fill revert and the order simply stays open. For a
    // Limit/TP that is an acceptable outcome; for a Stop-Loss "did not fill during a crash" IS
    // the loss — an inverted failure mode. SL therefore waits for v4.
    //
    // NOTE on the discriminator: the contract uses OrderType.STOP_LOSS (enum 1) for BOTH SL and
    // Take-Profit, so orderType alone cannot separate them. The condition can: a stop_loss order
    // triggering when price falls BELOW target is an SL; ABOVE is a Take-Profit.
    //
    // [SPRINT-P1B-SEC] Placed AFTER signature recovery and keyed on the ENUMS that were encoded
    // into the verified message — not on `body.orderType` / `body.priceCondition`. Recovery has
    // now proven the wallet signed a struct carrying exactly these enum values, so refusing on
    // them refuses the order that would actually execute on-chain. Deciding this from the raw
    // request strings (as it did before) allowed a casing desync — `priceCondition: 'BELOW'`
    // slipped past `=== 'below'` while still encoding condition = 1 into the signed struct.
    if (orderTypeEnum === ORDER_TYPE_STOP_LOSS && conditionEnum === CONDITION_BELOW) {
      return NextResponse.json(
        {
          error: STOP_LOSS_DEFERRED_REASON,
          detail:
            'A stop-loss needs a route that can still fill in a fast market. The current executor ' +
            'pins the route when you sign, which cannot be guaranteed to fill during a crash — so ' +
            'stop-loss orders are held back until the v4 executor ships. Take-Profit and Limit ' +
            'orders are unaffected.',
        },
        { status: 400 },
      )
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
      // [SPRINT-V3-P2] Only checked for a v3 order — od.maxSlippageBps is absent entirely on v2.
      if (isV3Order && Number(od.maxSlippageBps) !== Number(body.maxSlippageBps)) mismatchFields.push('maxSlippageBps')
      // [SPRINT-P1B] The pinned calldata's hash must match the hash the user SIGNED. Checked
      // inside the M-07 block because it is the same class of guarantee: order_data must not be
      // able to disagree with the signed struct.
      //
      // Only for a REAL hash: ZeroHash is the DCA/legacy shape, where order_data legitimately
      // omits routerDataHash entirely (and `'0x00..00'` is a truthy string, so a bare truthiness
      // check here would false-positive on every such order).
      if (
        body.routerDataHash &&
        body.routerDataHash !== zeroHash &&
        od.routerDataHash?.toLowerCase() !== body.routerDataHash.toLowerCase()
      ) {
        mismatchFields.push('routerDataHash')
      }
      if (mismatchFields.length > 0) {
        return NextResponse.json(
          { error: `order_data mismatch on fields: ${mismatchFields.join(', ')}` },
          { status: 400 },
        )
      }
    }

    // ── [SPRINT-P1B / ADR-014 (a)] Pinned-route integrity for non-DCA orders ─────────────────
    // Runs AFTER signature recovery on purpose: recovery has already proven the user signed
    // exactly `body.routerDataHash`, so verifying the stored calldata against it proves the
    // stored bytes are the ones that will satisfy the contract at :465. Doing this before
    // recovery would only compare two attacker-supplied values.
    //
    // The keeper replays these bytes verbatim and never rebuilds a route, so calldata that does
    // not match here would produce an order that can never fill. Reject at creation instead.
    // Scoped to v3 specifically: v3 is where pinned routes exist and where the executor enforces
    // the hash. The legacy v2 non-DCA path is left byte-identical (it is separately unexecutable
    // — threat-model P1c — but that is not this sprint's to change).
    if (isV3Order && orderTypeEnum !== ORDER_TYPE_DCA) {
      const storedRouterData = body.orderData?.routerData

      // codeql[js/user-controlled-bypass] — routerDataHash is part of the EIP-712 message just
      // verified, so this reads a signature-bound value; the contract re-enforces RouterDataRequired.
      if (!body.routerDataHash || body.routerDataHash === zeroHash) {
        return NextResponse.json(
          {
            error:
              'Non-DCA orders must commit to a real routerDataHash — the executor rejects ZeroHash ' +
              '(RouterDataRequired), so such an order could never execute.',
          },
          { status: 400 },
        )
      }
      // codeql[js/user-controlled-bypass] — presence precondition for the cryptographic check on the
      // next lines: verifyRouterDataHash compares these unsigned bytes against the SIGNED hash.
      if (!storedRouterData) {
        return NextResponse.json(
          { error: 'Non-DCA orders must include the pinned calldata in orderData.routerData' },
          { status: 400 },
        )
      }
      if (!verifyRouterDataHash(storedRouterData, body.routerDataHash)) {
        return NextResponse.json(
          { error: 'orderData.routerData does not hash to the signed routerDataHash' },
          { status: 400 },
        )
      }
      // The committed router must be one this chain actually serves. Never widens the executor's
      // on-chain whitelist — it only refuses a router we could not execute against.
      if (!isWhitelistedRouter(chainId, body.router)) {
        return NextResponse.json(
          { error: `Router ${body.router} is not served on chain ${chainId}` },
          { status: 400 },
        )
      }
    }

    // [SPRINT-V3-P2 / ADR-013 §1, I-01+L-01 off-chain closure] USD dust floor for v3 orders only
    // — v2's minAmountOut is meaningless (always '1', the on-chain clamp made it a no-op), so
    // there is nothing to dust-check there. A v3 order's minAmountOut is the SIGNED absolute
    // floor the contract enforces verbatim on no-feed pairs — a dust-sized signed min is exactly
    // as unprotective as the old 1-wei clamp, so reject it here rather than let it reach the
    // contract. Prices the tokenOut leg (DefiLlama + server Chainlink, same plumbing /api/swap's
    // >$10k gate uses); unpriceable on BOTH sources fails CLOSED (mirrors that gate's posture) —
    // never trust the client's own derivation.
    //
    // [SPRINT-V3-P3 / M-01] The decimals used to convert body.minAmountOut into a human token
    // amount MUST come from the chain, never from body.tokenOutDecimals: a client that inflates
    // (or deflates) its claimed decimals shifts the computed USD value by a power of 10 and can
    // make a genuinely-dust minAmountOut look economically meaningful (or vice versa) to this
    // gate — the exact bypass the audit flagged. fetchErc20Decimals reads decimals() on-chain via
    // RPC; a client value that disagrees is a malformed/malicious order, rejected outright (422),
    // not silently corrected or merely warned about. If the on-chain read itself fails, the floor
    // cannot be computed with any authority at all — fail closed exactly like the unpriceable
    // branch below (never fall back to the untrusted client figure).
    if (isV3Order) {
      const dustFloorUsd = getDcaMinChunkUsd()
      const llamaChain = (() => {
        try { return getChainConfig(chainId).slug } catch { return 'ethereum' }
      })()

      const onChainDecimals = await fetchErc20Decimals(body.tokenOut, chainId).catch(() => null)
      if (onChainDecimals === null) {
        return NextResponse.json(
          {
            error: 'Order value cannot be verified: could not read tokenOut decimals on-chain. Unpriceable v3 orders are blocked.',
            unpriceable: true,
          },
          { status: 422 },
        )
      }
      if (body.tokenOutDecimals !== undefined && body.tokenOutDecimals !== null && Number(body.tokenOutDecimals) !== onChainDecimals) {
        return NextResponse.json(
          { error: `tokenOutDecimals mismatch: client claimed ${body.tokenOutDecimals}, on-chain reports ${onChainDecimals}` },
          { status: 422 },
        )
      }

      let minOutUsd: number | null = null
      try {
        const [llama, link] = await Promise.all([
          fetchDefiLlamaPrice(body.tokenOut, llamaChain).catch(() => null),
          computeTokenAmountUsd(body.tokenOut, String(body.minAmountOut), chainId).catch(() => null),
        ])
        // [M-01] onChainDecimals — the RPC-verified value — not the client-supplied figure.
        const minOutFloat = Number(body.minAmountOut) / 10 ** onChainDecimals
        const candidates = [
          llama && Number.isFinite(minOutFloat) ? minOutFloat * llama.price : null,
          link?.usd ?? null,
        ].filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
        // [M-01] min-combine: the floor gate must be the HARDEST of the two independent
        // estimates to pass, not the easiest — max() let a manipulated/optimistic single leg
        // wave a dust order through whenever the other leg happened to price it generously.
        if (candidates.length > 0) minOutUsd = Math.min(...candidates)
      } catch {
        // Each leg already degrades to null individually; a wholesale failure leaves minOutUsd
        // null and the fail-CLOSED branch below fires.
      }

      if (minOutUsd === null) {
        return NextResponse.json(
          {
            error: 'Order value cannot be verified: no price coverage (DefiLlama or Chainlink) for the output token. Unpriceable v3 orders are blocked.',
            unpriceable: true,
          },
          { status: 422 },
        )
      }
      if (minOutUsd < dustFloorUsd) {
        return NextResponse.json(
          {
            error: `minAmountOut is below the $${dustFloorUsd} minimum ($${minOutUsd.toFixed(4)}) — the signed floor must be economically meaningful, not dust.`,
            minimumUsd: dustFloorUsd,
          },
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
        order_type: orderTypeLabel,
        token_in: body.tokenIn.toLowerCase(),
        token_in_symbol: body.tokenInSymbol,
        token_out: body.tokenOut.toLowerCase(),
        token_out_symbol: body.tokenOutSymbol,
        amount_in: body.amountIn,
        min_amount_out: body.minAmountOut,
        target_price: body.targetPrice,
        price_feed: body.priceFeed?.toLowerCase() || '',
        price_condition: priceConditionLabel,
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

  // Support comma-separated statuses: ?status=active,executing,partially_filled
  const statuses = (status ?? '').split(',').map(s => s.trim()).filter(Boolean)

  // [AUDIT-W6 / W6-M-01] Reads that include ACTIVE/PENDING order strategy
  // (targetPrice / amounts / type, pre-execution) require proof of wallet
  // ownership — one lightweight session signature (read-auth.ts), same trust
  // anchor as the write path. No status filter defaults to "everything",
  // which includes live orders → protected. Unknown statuses are protected
  // too (default-deny). Terminal-only reads stay public — the owner-decided
  // boundary (on-chain history is public; matches /history + analytics).
  const needsOwnershipProof =
    statuses.length === 0 || statuses.some(s => !PUBLIC_ORDER_STATUSES.has(s))
  if (needsOwnershipProof) {
    const auth = await verifyOrdersReadAccess({
      wallet,
      issuedAt: req.headers.get(ORDERS_READ_HEADER_ISSUED),
      signature: req.headers.get(ORDERS_READ_HEADER_SIGNATURE),
    })
    if (!auth.ok) {
      return NextResponse.json(
        {
          error: `Reading active orders requires a wallet signature: ${auth.error}`,
          code: 'READ_AUTH_REQUIRED',
        },
        { status: 401 },
      )
    }
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

  if (statuses.length === 1) {
    query = query.eq('status', statuses[0])
  } else if (statuses.length > 1) {
    query = query.in('status', statuses)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ orders: [], error: error.message })
  return NextResponse.json({ orders: data ?? [] })
}
