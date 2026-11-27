import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
// [P114/M-03] POST inserts through the logger (INSERT-only) client. Its reads (are the verification columns there, how
// many pending rows has this wallet) and everything PATCH does need the service role: the logger role can neither
// SELECT nor UPDATE.
import { getSupabase, getSupabaseLogger } from '@/lib/supabase'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { checkRateLimitWithin, LOG_CHAINLESS_RATE_LIMIT, LOG_RATE_LIMIT, LOG_READ_BUDGET } from '@/lib/kv-rate-limiter'
import { bodySizeGuard, clientIp } from '@/lib/body-limit'
import { forLog } from '@/lib/log-sanitize'
import { confirmSwap, type ConfirmResult } from '@/lib/swap-log/confirm'
import { parseConfirmSwap, parsePendingSwap } from '@/lib/swap-log/input'
import { findWalletVerifiedByTx, hasMainRow, insertPending, makeRoomForPending, verifiedColumnsState } from '@/lib/swap-log/store'
import { catalogSymbol } from '@/lib/swap-log/symbols'

// [133b H.5] A confirmation that names its chain (the official client's) reads that chain twice: up to 4 + 9.5 + 9.5 s
// (chain-id proof, transaction, receipt; each read one attempt and one retry, 4 s each, 1.5 s before a null is asked
// again), then prices up to two tokens. One that names no chain asks the candidate chains in turn and starts no new one
// after 20 s (confirm.ts CHAIN_SEARCH_BUDGET_MS): at most 20 + 13.5 + 9.5 s of chain reads before pricing, so the claim
// is stored well inside this limit. [133c Q] A chain that returned the transaction ends the search (a failed receipt
// read included), every upstream call is paid from the per-IP read budget (LOG_READ_BUDGET), and a confirmation naming
// no chain has its own per-IP limit (LOG_CHAINLESS_RATE_LIMIT).
export const maxDuration = 60

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

/**
 * [ADR-029 8.4, details Q.2 of goal 133c] The per-IP read budget: asked before every upstream chain call this request
 * triggers (chain-read.ts). `false`: that call is not sent, and the confirmation answers 202 (the claim stored if the
 * claim rules allow). The key is the one-way hash of the client IP, as for every limiter.
 */
function readBudgetOf(req: NextRequest): () => Promise<boolean> {
  const key = `log-reads:${clientIp(req)}`
  return async () => (await checkRateLimitWithin(key, LOG_READ_BUDGET.limit, LOG_READ_BUDGET.windowMs)).allowed
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
 *   - [133b J] pending rows are scratch, and the cap never refuses: at 5 pending rows of the wallet in the last hour
 *     the wallet's oldest scratch row is retired first (store.ts makeRoomForPending); only the per-IP limit answers 429.
 * A row becomes `confirmed` or `failed` only by the server, after it read the transaction on-chain. A transaction hash
 * sent with the POST (the split-swap client sends one, after its receipt) is handled as a PATCH on the POST's chain
 * after the insert; a hash main stored for this wallet on that chain inserts nothing (ADR-029 9.1). The official
 * client's calls keep their answer: 200 `{ ok: true }`.
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
    if (input.txHash !== null && (await findWalletVerifiedByTx(db, input.wallet, input.txHash)) === true) return NextResponse.json({ ok: true })
    // [ADR-029 9.1, A106 R3-1; owner's answer of 2026-11-27] A hash main stored for this wallet on this chain: that row
    // stands for the swap and is read-only, so nothing is inserted beside it and the chain is not read. Unsure (the
    // lookup failed): nothing is written either.
    if (input.txHash !== null) {
      const mainRow = await hasMainRow(db, input.wallet, input.chainId, input.txHash)
      if (mainRow === 'error') return NextResponse.json({ ok: false, error: 'storage_unavailable' })
      if (mainRow) return NextResponse.json({ ok: true })
    }

    // Details J: make room (never refuse). A failed read of the scratch rows does not stop the insert.
    if ((await makeRoomForPending(db, input.wallet, new Date())) === 'error') console.warn('[log-swap] pending cap not applied')

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

    // The hash was NOT stored with the row: only a verification writes one (or keeps it as a claim). Whatever the chain
    // says, the row above exists and the POST is answered as before.
    if (input.txHash !== null) {
      const confirmed = await confirmSwap({ db, wallet: input.wallet, txHash: input.txHash, chainId: input.chainId }, { beforeUpstream: readBudgetOf(req) })
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
    // Verified now (a pending row of the wallet updated, or a row made by the transaction), or already verified for
    // this wallet and this transaction: the browser's call is answered as before.
    case 'verified':
      return NextResponse.json({ ok: true })
    // The chain has no such transaction or receipt yet, or could not be read: the hash is kept as a private claim and
    // the client asks again (analytics.ts: after 2, 8 and 30 s).
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
 * [ADR-029 section 7, details I of goal 133b] The browser calls this when it saw the transaction confirm. The body is
 * `{ txHash, wallet, chainId? }`; a status, gas figures or mev figures in it are not read. The server then reads the
 * transaction on that chain (or, with no chain, on the candidate chains: H.5) and THE TRANSACTION MAKES THE ROW
 * (lib/swap-log/confirm.ts): its derived values go to a pending row of THAT wallet that agrees with it, or to a new row
 * (never a row of another wallet). 202 when the chain has no such transaction yet (the hash is kept as a private claim
 * and the client asks again), 422 when it is not this wallet's swap, 409 only when the unique index refuses a write and
 * no verified row of this wallet carries the hash.
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

    // [ADR-029 8.4, details Q.1] A confirmation that names no chain of the app asks every chain: its own small per-IP
    // limit, on top of the shared one. The official client always names the chain. Asked only once the chain would be
    // read (after the migration check), so the answers before the migration is applied are main's.
    if (parsed.value.chainId === null) {
      const chainless = await checkRateLimitWithin(`log-chainless:${clientIp(req)}`, LOG_CHAINLESS_RATE_LIMIT.limit, LOG_CHAINLESS_RATE_LIMIT.windowMs)
      if (!chainless.allowed) {
        return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'X-RateLimit-Reset': String(chainless.resetAt) } })
      }
    }

    return confirmResponse(
      await confirmSwap({ db, wallet: parsed.value.wallet, txHash: parsed.value.txHash, chainId: parsed.value.chainId }, { beforeUpstream: readBudgetOf(req) }),
    )
  } catch {
    console.error('[log-swap] PATCH failed')
    return NextResponse.json({ ok: true })
  }
}
