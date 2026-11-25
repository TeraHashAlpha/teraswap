import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
// [P114/M-03] POST inserts through the logger (INSERT-only) client. Its two reads (are the verification columns
// there, how many pending rows has this wallet) and everything PATCH does need the service role: the logger role
// can neither SELECT nor UPDATE.
import { getSupabase, getSupabaseLogger } from '@/lib/supabase'
import { trackSwapFailed } from '@/lib/security-tracker'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { checkRateLimitWithin, LOG_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { bodySizeGuard, clientIp } from '@/lib/body-limit'
import { forLog } from '@/lib/log-sanitize'
import { parsePendingSwap } from '@/lib/swap-log/input'
import { PENDING_CAP, PENDING_CAP_WINDOW_MS, countRecentPending, insertPending, verifiedColumnsState } from '@/lib/swap-log/store'
import { catalogSymbol } from '@/lib/swap-log/symbols'

// [AUDIT-W6 / W6-M-02 + W6-L-01] Shared guards for both handlers: body cap +
// the per-IP budget shared by all log-* routes, BEFORE any parse/DB work.
async function ingestionGuards(req: NextRequest): Promise<NextResponse | null> {
  const tooLarge = bodySizeGuard(req)
  if (tooLarge) return tooLarge
  const rate = await checkRateLimitWithin(`log:${clientIp(req)}`, LOG_RATE_LIMIT.limit, LOG_RATE_LIMIT.windowMs)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'X-RateLimit-Reset': String(rate.resetAt) } },
    )
  }
  return null
}

/** [ADR-029, details E] The one line logged while the migration is not applied: nothing is written then. */
function logColumnsMissing(): void {
  console.warn('[log-swap] swaps_verified_columns_missing')
}

/**
 * POST /api/log-swap
 *
 * [ADR-029, details B] The browser calls this when the user submits a swap: no transaction exists yet, so nothing
 * here can be checked on-chain. It therefore inserts ONLY a private pending row, from validated input:
 *   - the wallet, the chain, the source (a name of the app's list), the two token ADDRESSES and the two declared
 *     amounts (decimal digits); anything else is a 400;
 *   - the symbols are the token catalog's for those addresses on that chain, never the caller's text;
 *   - status is `pending`, there is no transaction hash, no USD value, no fee amount, no mev figure, whatever the
 *     body says, and no alert or tracker call carries a USD value;
 *   - at most PENDING_CAP pending rows per wallet per hour: the next one is a 429.
 * A row becomes `confirmed` or `failed` only by the server, after it read the transaction on-chain (PATCH).
 * The official client's calls keep their answer: 200 `{ ok: true }`.
 */
export async function POST(req: NextRequest) {
  try {
    const refused = await ingestionGuards(req)
    if (refused) return refused

    const logger = getSupabaseLogger()
    const db = getSupabase()
    if (!logger || !db) {
      console.warn('[log-swap] Supabase not configured — swap NOT logged. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.')
      return NextResponse.json({ ok: false, skipped: true, reason: 'supabase_not_configured' })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      // Not JSON, or longer than the body cap: as before, a 200 that says it was not logged.
      return NextResponse.json({ ok: false, error: 'invalid_body' })
    }

    const parsed = parsePendingSwap(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const input = parsed.value

    const columns = await verifiedColumnsState(db)
    if (columns === 'missing') {
      logColumnsMissing()
      return NextResponse.json({ ok: true })
    }
    if (columns === 'unknown') return NextResponse.json({ ok: false, error: 'storage_unavailable' })

    const pending = await countRecentPending(db, input.wallet, new Date(Date.now() - PENDING_CAP_WINDOW_MS).toISOString())
    if (pending === null) return NextResponse.json({ ok: false, error: 'storage_unavailable' })
    if (pending >= PENDING_CAP) {
      return NextResponse.json({ error: 'Too many pending swaps for this wallet. Try again later.' }, { status: 429 })
    }

    const tokenInSymbol = catalogSymbol(input.tokenIn, input.chainId)
    const tokenOutSymbol = catalogSymbol(input.tokenOut, input.chainId)

    const inserted = await insertPending(logger, {
      id: randomUUID(),
      wallet: input.wallet,
      chain_id: input.chainId,
      source: input.source,
      token_in: input.tokenIn,
      token_in_symbol: tokenInSymbol,
      token_out: input.tokenOut,
      token_out_symbol: tokenOutSymbol,
      amount_in: input.amountIn,
      amount_out: input.amountOut,
      slippage: input.slippage,
      mev_protected: input.mevProtected,
      fee_collected: input.feeCollected,
      expected_output: input.expectedOutput,
      // [P96] Gasless flag — derived from source (server is authoritative).
      is_gasless: input.source === 'cowswap',
      gas_savings_usd: input.gasSavingsUsd,
    })
    if (!inserted.ok) {
      // The database's error text can quote the row: only its code is logged.
      console.error(`[log-swap] insert failed code=${forLog(inserted.code, 20)}`)
      return NextResponse.json({ ok: false, error: 'insert_failed' })
    }

    // Wallet activity (fire-and-forget): validated values only, no USD, no transaction hash.
    trackWalletAction(input.wallet, {
      category: 'swap',
      action: 'swap_logged',
      source: input.source,
      tokenIn: tokenInSymbol,
      tokenOut: tokenOutSymbol,
      metadata: { status: 'pending', slippage: input.slippage, mevProtected: input.mevProtected, feeCollected: input.feeCollected },
    })

    return NextResponse.json({ ok: true })
  } catch {
    // No error text: an error message can carry what the caller sent.
    console.error('[log-swap] POST failed')
    return NextResponse.json({ ok: false, error: 'internal_error' })
  }
}

/**
 * PATCH /api/log-swap
 *
 * Update a swap record after tx confirmation (add tx_hash, gas, status).
 */
export async function PATCH(req: NextRequest) {
  try {
    const refused = await ingestionGuards(req)
    if (refused) return refused

    const supabase = getSupabase()
    if (!supabase) {
      console.warn('[log-swap] PATCH skipped — Supabase not configured')
      return NextResponse.json({ ok: false, skipped: true, reason: 'supabase_not_configured' })
    }

    const body = await req.json()
    const { txHash, status, gasUsed, gasPrice, wallet, mevSavingsEstimate, mevSavingsActual } = body

    if (!txHash) {
      return NextResponse.json(
        { error: 'txHash is required' },
        { status: 400 },
      )
    }

    const update: Record<string, unknown> = { status, tx_hash: txHash }
    if (gasUsed) update.gas_used = gasUsed
    if (gasPrice) update.gas_price = gasPrice
    // [LP-05] Optional MEV-savings telemetry — only set when caller provided
    // a value so we don't overwrite an existing row's columns with NULL.
    if (mevSavingsEstimate != null) update.mev_savings_estimate = mevSavingsEstimate
    if (mevSavingsActual != null) update.mev_savings_actual = mevSavingsActual

    // Track failed swap server-side
    if (status === 'failed' && wallet) {
      trackSwapFailed({ wallet, tokenIn: '', tokenOut: '', amountUsd: 0, source: '', error: 'Transaction reverted' })
      trackWalletAction(wallet, {
        category: 'swap', action: 'swap_status_update',
        txHash, metadata: { status: 'failed' },
      })
    }

    // Try 1: Match by tx_hash (row already has the hash)
    const { data: matched, error: err1 } = await supabase
      .from('swaps')
      .update(update)
      .eq('tx_hash', txHash)
      .select('id')

    if (err1) {
      console.error('[log-swap] PATCH by tx_hash error:', err1.message)
    }

    // Try 2: If no row matched (initial log had tx_hash=null), find latest pending for this wallet
    if ((!matched || matched.length === 0) && wallet) {
      const { error: err2 } = await supabase
        .from('swaps')
        .update(update)
        .eq('wallet', wallet.toLowerCase())
        .eq('status', 'pending')
        .is('tx_hash', null)
        .order('created_at', { ascending: false })
        .limit(1)

      if (err2) {
        console.error('[log-swap] PATCH by wallet fallback error:', err2.message)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[log-swap] PATCH Error:', err)
    return NextResponse.json({ ok: true })
  }
}
