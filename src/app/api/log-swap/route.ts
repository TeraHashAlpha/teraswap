import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
// [P114/M-03] POST inserts through the logger (INSERT-only) client. Its reads (are the verification columns there, how
// many pending rows has this wallet) and everything PATCH does need the service role: the logger role can neither
// SELECT nor UPDATE.
import { getSupabase, getSupabaseLogger } from '@/lib/supabase'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { checkRateLimitWithin, LOG_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { bodySizeGuard, clientIp } from '@/lib/body-limit'
import { forLog } from '@/lib/log-sanitize'
import { confirmSwap, type ConfirmResult } from '@/lib/swap-log/confirm'
import { parseConfirmSwap, parsePendingSwap } from '@/lib/swap-log/input'
import {
  PENDING_CAP,
  PENDING_CAP_WINDOW_MS,
  countRecentPending,
  findWalletRowByTx,
  insertPending,
  verifiedColumnsState,
} from '@/lib/swap-log/store'
import { catalogSymbol } from '@/lib/swap-log/symbols'

// A confirmation reads the chain twice (4 s per attempt, one retry each) and prices up to two tokens.
export const maxDuration = 30

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
 * A row becomes `confirmed` or `failed` only by the server, after it read the transaction on-chain. A transaction hash
 * sent with the POST (the split-swap client sends one, after its receipt) is handled as a PATCH after the insert.
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

    // A repeat of a POST whose transaction this wallet already has verified: nothing to add.
    if (input.txHash !== null) {
      const existing = await findWalletRowByTx(db, input.wallet, input.txHash)
      if (existing !== null && existing !== 'error' && existing.verified_at !== null) return NextResponse.json({ ok: true })
    }

    const pending = await countRecentPending(db, input.wallet, new Date(Date.now() - PENDING_CAP_WINDOW_MS).toISOString())
    if (pending === null) return NextResponse.json({ ok: false, error: 'storage_unavailable' })
    if (pending >= PENDING_CAP) {
      return NextResponse.json({ error: 'Too many pending swaps for this wallet. Try again later.' }, { status: 429 })
    }

    const tokenInSymbol = catalogSymbol(input.tokenIn, input.chainId)
    const tokenOutSymbol = catalogSymbol(input.tokenOut, input.chainId)
    const rowId = randomUUID()

    const inserted = await insertPending(logger, {
      id: rowId,
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

    // The hash was NOT stored with the row: only a verification writes one. Whatever the chain says, the row above
    // exists and the POST is answered as before.
    if (input.txHash !== null) {
      const confirmed = await confirmSwap({ db, wallet: input.wallet, txHash: input.txHash, rowId })
      if (confirmed.result === 'columns_missing') logColumnsMissing()
    }

    return NextResponse.json({ ok: true })
  } catch {
    // No error text: an error message can carry what the caller sent.
    console.error('[log-swap] POST failed')
    return NextResponse.json({ ok: false, error: 'internal_error' })
  }
}

/** What each outcome of a confirmation answers (details C). */
function confirmResponse(confirmed: ConfirmResult): NextResponse {
  switch (confirmed.result) {
    // Verified now, or already verified for this wallet and this transaction; or this wallet has no row to confirm
    // (its POST was refused or never came): in all three the browser's call is answered as before.
    case 'verified':
    case 'no_row':
      return NextResponse.json({ ok: true })
    // The chain has no such transaction or receipt yet, or could not be read: the row is unchanged; ask again later.
    case 'not_found':
      return NextResponse.json({ ok: false, outcome: 'not_found' }, { status: 202 })
    case 'rejected':
      return NextResponse.json({ error: 'Transaction not accepted for this swap' }, { status: 422 })
    case 'duplicate':
      return NextResponse.json({ error: 'Transaction already recorded' }, { status: 409 })
    case 'columns_missing':
      logColumnsMissing()
      return NextResponse.json({ ok: true })
    case 'storage_error':
      console.error('[log-swap] PATCH storage error')
      return NextResponse.json({ ok: false, error: 'storage_unavailable' })
  }
}

/**
 * PATCH /api/log-swap
 *
 * [ADR-029, details C] The browser calls this when it saw the transaction confirm. The body is `{ txHash, wallet }`;
 * a status, gas figures or mev figures in it are not read. The server then:
 *   - picks the row of THAT wallet with that hash, else that wallet's latest pending row of the last two hours
 *     (never a row of another wallet);
 *   - reads the transaction on the ROW's chain (lib/swap-verify) and, only if it is this wallet's swap, writes status,
 *     hash, derived tokens, amounts, symbols, USD and gas in one update;
 *   - 202 when the chain has no such transaction yet, 422 when it is not this row's swap, 409 when it already
 *     verified a row of another wallet: in all three the row is unchanged.
 */
export async function PATCH(req: NextRequest) {
  try {
    const refused = await ingestionGuards(req)
    if (refused) return refused

    const db = getSupabase()
    if (!db) {
      console.warn('[log-swap] PATCH skipped — Supabase not configured')
      return NextResponse.json({ ok: false, skipped: true, reason: 'supabase_not_configured' })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      // Not JSON, or longer than the body cap: as before.
      return NextResponse.json({ ok: true })
    }

    const parsed = parseConfirmSwap(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    // No wallet named (the browser's call after the wallet disconnected): there is no row to look for. Answered as
    // before; nothing is read and nothing is written.
    if (parsed.value.wallet === null) return NextResponse.json({ ok: true })

    const columns = await verifiedColumnsState(db)
    if (columns === 'missing') {
      logColumnsMissing()
      return NextResponse.json({ ok: true })
    }
    if (columns === 'unknown') return NextResponse.json({ ok: false, error: 'storage_unavailable' })

    return confirmResponse(await confirmSwap({ db, wallet: parsed.value.wallet, txHash: parsed.value.txHash }))
  } catch {
    console.error('[log-swap] PATCH failed')
    return NextResponse.json({ ok: true })
  }
}
