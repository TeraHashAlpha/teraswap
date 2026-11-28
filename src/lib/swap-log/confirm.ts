/**
 * [ADR-029 section 7.2 and 7.3, details I of goal 133b] A confirmation: THE TRANSACTION MAKES THE ROW.
 *
 * A confirmation carries a wallet, a transaction hash and, when the client knows it, the chain. The server reads the
 * transaction on the candidate chains (verify-swap-on-chain.ts) and takes kind, source, tokens and amounts from the
 * chain. Then:
 *   confirmed / failed  the result goes to the newest POST row of THAT wallet on that chain that agrees with it (same in
 *                       token; for a reverted call that names no token, the same source), which keeps its slippage and
 *                       expected_output (owner's answer of 2026-11-25); else to a claim row of THIS hash; else a new
 *                       verified row is inserted. A claim row of another hash is never a candidate (details P.2 of goal
 *                       133c). Either way the row carries only derived values plus the wallet and the hash, and the
 *                       claim rows of this hash are gone afterwards (reused, or deleted).
 *   not_found           the hash is never thrown away: it is kept as a PRIVATE claim on a row of its own, one per
 *                       (wallet, claimed chain or none, hash) (ADR-029 8.3, P.1); a POST row never holds a claim. The
 *                       caller answers 202 and the client asks again. At CLAIM_CAP claims the chain is asked about the
 *                       wallet's oldest claims first (P.3); a claim leaves only by the chain's answer or by age.
 *   rejected            the chain answered and it is not this wallet's swap: the claims of that hash are deleted.
 * POST rows are private scratch: hints for the chain read (a tie-break) and places to attach, never proof.
 *
 * Nothing written comes from the caller but the wallet and the hash the chain was asked about (and, in a claim, the
 * chain the caller named). The trackers (large trade, oracle, failed swap) run after the write, from derived values.
 * USD is the server's price of the DERIVED amounts; for a router row that paid ETH in, only when the out side is worth
 * at least half as much and at most twice as much (ADR-029 8.2, details O): else no USD and no security event. Inside
 * that band its in side counts the smaller of the two values (ADR-029 9.2, A106 R3-2). The oracle-deviation alert alone
 * is computed from the two values as priced, before the smaller is taken (A107 R4-1): from the stored ones it is 0.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { computeTokenAmountUsd } from '@/lib/chainlink'
import { getSupportedChainIds, getWrappedNative } from '@/lib/chains/registry'
import { forLog } from '@/lib/log-sanitize'
import { trackLargeTrade, trackOracleDeviation, trackOracleUnavailable, trackSwapFailed } from '@/lib/security-tracker'
import {
  NATIVE_PLACEHOLDER,
  UNKNOWN_SOURCE,
  isSwapLogChain,
  verifySwapOnChain,
  type DerivedSwap,
  type VerifiedKind,
  type VerifyDeps,
  type VerifyReason,
  type VerifySwapResult,
} from '@/lib/swap-verify/verify-swap-on-chain'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import {
  CLAIM_CAP,
  CLAIM_CHECK_AFTER_MS,
  CLAIM_CHECKS_PER_REQUEST,
  PENDING_MATCH_WINDOW_MS,
  deleteClaimRow,
  deleteClaimsOf,
  deleteExpiredClaims,
  findCandidateRows,
  findClaimRows,
  findWalletVerifiedByTx,
  hasMainRow,
  insertClaimRow,
  insertVerified,
  markVerified,
  type ClaimRow,
  type PendingCandidate,
  type VerifiedUpdate,
} from './store'
import { catalogSymbolOrNull } from './symbols'

/** A trade at or above this many USD is recorded as a large trade (monitoring only). */
export const LARGE_TRADE_USD = 50_000
/** The two derived sides differ by at least this fraction of the sold side: recorded as an oracle deviation. */
export const ORACLE_DEVIATION_WARN = 0.02
/**
 * A confirmation without a chain asks one chain after another; it starts no further chain once this much time has
 * gone, so the claim is stored well inside the route's maxDuration (route.ts). The chain the client names is asked
 * whatever the time.
 */
export const CHAIN_SEARCH_BUDGET_MS = 20_000

export type ConfirmResult =
  /** Verified now (a row updated or inserted), or already verified for this wallet and this transaction. */
  | { result: 'verified' }
  /** The chain has no such transaction or receipt (yet), or could not be read: the hash is kept as a claim. */
  | { result: 'not_found'; reason: VerifyReason; claimed: boolean }
  /** The chain answered: the transaction is not this wallet's swap. */
  | { result: 'rejected'; reason: VerifyReason }
  /** The unique index refused the write and no verified row of this wallet carries the hash. */
  | { result: 'duplicate' }
  | { result: 'columns_missing' }
  | { result: 'storage_error' }

/**
 * [ADR-029 8.2, details O of goal 133c] The smallest ratio of the two USD values of a router row whose in side is the
 * ETH the transaction paid. That ETH leaves no log, and ETH coming back (a refund) leaves none either, so the chain does
 * not show how much of it was spent; what came back for it is the only measure. Both sides priced and within a factor
 * of two: both USD values are stored, the in side as the SMALLER of the two (ADR-029 9.2, A106 R3-2: up to half the ETH
 * paid may have come back, so the value paid is capped by what was received; an honest swap is counted slightly below
 * what was paid, fee and slippage, accepted). Otherwise the row is confirmed with no USD at all.
 */
export const ETH_IN_USD_MIN_RATIO = 0.5

/** O.2 and 9.2: the two USD values of an ETH-in router row (in = min(usdIn, usdOut)), or null for both. */
export function ethInUsd(usdIn: number | null, usdOut: number | null): { in: number | null; out: number | null } {
  if (usdIn === null || usdOut === null) return { in: null, out: null }
  const high = Math.max(usdIn, usdOut)
  const low = Math.min(usdIn, usdOut)
  if (!(high > 0) || !(low / high >= ETH_IN_USD_MIN_RATIO)) return { in: null, out: null }
  return { in: low, out: usdOut }
}

/** USD of a derived side, by the server's own price read. null when the side is null or has no price. */
async function usdOfSide(chainId: number, token: string | null, amount: string | null): Promise<number | null> {
  if (token === null || amount === null) return null
  // Native ETH is priced as the chain's wrapped native (same asset, and it has the feed and the decimals).
  const priced = await computeTokenAmountUsd(token === NATIVE_PLACEHOLDER ? getWrappedNative(chainId) : token, amount, chainId).catch(() => null)
  const usd = priced?.usd
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd >= 1e15) return null
  return Math.round(usd * 100) / 100
}

function buildUpdate(
  txHash: string,
  outcome: 'confirmed' | 'failed',
  kind: VerifiedKind,
  chainId: number,
  derived: DerivedSwap,
  usd: { in: number | null; out: number | null },
  now: Date,
): VerifiedUpdate {
  return {
    status: outcome,
    tx_hash: txHash,
    verified_at: now.toISOString(),
    verified_kind: kind,
    source: derived.source,
    token_in: derived.tokenIn,
    token_in_symbol: catalogSymbolOrNull(derived.tokenIn, chainId),
    token_out: derived.tokenOut,
    token_out_symbol: catalogSymbolOrNull(derived.tokenOut, chainId),
    amount_in: derived.amountIn,
    amount_out: derived.amountOut,
    amount_in_usd: usd.in,
    amount_out_usd: usd.out,
    gas_used: derived.gasUsed,
    gas_price: derived.gasPrice,
    // Derived from what the transaction was, never from the POST's flags.
    fee_collected: kind === 'fee_collector',
    fee_amount: null,
    is_gasless: kind === 'cow',
    mev_protected: kind === 'cow',
    // Not derivable: cleared until phase 2 (ADR-029 section 5).
    gas_savings_usd: 0,
    mev_savings_estimate: null,
    mev_savings_actual: null,
    claimed_tx_hash: null,
    claimed_chain_id: null,
    claimed_at: null,
  }
}

/**
 * After a verified write: the trackers, from derived values only. Fire-and-forget, as the trackers are.
 * `usdWithheld` (O.2, owner's answer of 2026-11-26): an ETH-in router row whose USD was not stored raises no security
 * event (no large trade, no oracle unavailable, no oracle deviation); its wallet-activity line is still written, with
 * no USD, as for any confirmed swap whose token has no price.
 * `priced` (A107 R4-1): the two sides as the oracle priced them. They differ from the stored values only on an ETH-in
 * router row, whose stored in side is the smaller one (ADR-029 9.2).
 */
function runTrackers(wallet: string, txHash: string, update: VerifiedUpdate, priced: { in: number | null; out: number | null }, usdWithheld = false): void {
  const tokenIn = update.token_in_symbol ?? ''
  const tokenOut = update.token_out_symbol ?? ''
  const tradeUsd = update.amount_in_usd ?? update.amount_out_usd ?? 0

  if (update.status === 'failed') {
    trackSwapFailed({ wallet, tokenIn: '', tokenOut: '', amountUsd: 0, source: update.source, error: 'Transaction reverted' })
    trackWalletAction(wallet, { category: 'swap', action: 'swap_status_update', source: update.source, success: false, txHash, metadata: { status: 'failed', kind: update.verified_kind } })
    return
  }

  trackWalletAction(wallet, {
    category: 'swap',
    action: 'swap_status_update',
    source: update.source,
    tokenIn: update.token_in_symbol ?? undefined,
    tokenOut: update.token_out_symbol ?? undefined,
    amountUsd: update.amount_in_usd ?? update.amount_out_usd ?? undefined,
    success: true,
    txHash,
    metadata: { status: 'confirmed', kind: update.verified_kind },
  })
  if (usdWithheld) return

  if (tradeUsd >= LARGE_TRADE_USD) {
    trackLargeTrade({ wallet, tokenIn, tokenOut, amountUsd: tradeUsd, source: update.source })
  }

  // A derived side the server could not price: the oracle had no answer for that token.
  const inUnpriced = update.amount_in !== null && update.amount_in_usd === null
  const outUnpriced = update.amount_out !== null && update.amount_out_usd === null
  if (inUnpriced || outUnpriced) {
    trackOracleUnavailable({ wallet, tokenIn: inUnpriced ? tokenIn : tokenOut, tokenOut: inUnpriced ? tokenOut : tokenIn, amountUsd: tradeUsd, blocked: false })
  }

  // Both sides priced by the oracle and far apart: what was paid and what was received disagree at oracle prices.
  // The event's USD is the value the row counts.
  if (update.amount_in_usd !== null && priced.in !== null && priced.out !== null && priced.in > 0) {
    const deviation = Math.abs(priced.in - priced.out) / priced.in
    if (deviation >= ORACLE_DEVIATION_WARN) {
      trackOracleDeviation({ wallet, tokenIn, tokenOut, deviation, amountUsd: update.amount_in_usd, blocked: false })
    }
  }
}

export interface ConfirmDeps extends VerifyDeps {
  now?: () => Date
  /** false: the stored-rows script, which reports instead of alerting. Default true. */
  trackers?: boolean
  /** Test seam for CHAIN_SEARCH_BUDGET_MS: milliseconds since the confirmation started. */
  elapsedMs?: () => number
}

export interface ConfirmArgs {
  /** The service-role client: the lookups and the writes. */
  db: SupabaseClient
  /** Lowercase, validated. */
  wallet: string
  /** Lowercase, validated. */
  txHash: string
  /** The chain the client named, when it is one of the app's; otherwise null (details H.5). */
  chainId?: number | null
}

/** A claim row (P.1): a row of its own holding one claim; a POST row never holds one. */
const isClaimRow = (row: PendingCandidate) => row.claimed_tx_hash !== null

/** A timestamp in milliseconds; a missing or unreadable one is the oldest. */
function time(value: string | null): number {
  const ms = value === null ? Number.NaN : Date.parse(value)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

/**
 * H.5: the chains to ask, in order. The chain the client named; else the chains of the wallet's POST rows (newest
 * first) and the chains its claims of this hash name, then the app's other chains in the registry's order (owner's
 * answer of 2026-11-26: all chains).
 */
function chainsToAsk(chainId: number | null | undefined, candidates: readonly PendingCandidate[]): number[] {
  if (chainId !== undefined && chainId !== null && isSwapLogChain(chainId)) return [chainId]
  const order: number[] = []
  for (const row of candidates) {
    const chain = isClaimRow(row) ? row.claimed_chain_id : row.chain_id
    if (chain !== null && isSwapLogChain(chain) && !order.includes(chain)) order.push(chain)
  }
  for (const chain of getSupportedChainIds()) if (!order.includes(chain)) order.push(chain)
  return order
}

interface Found {
  chainId: number
  result: VerifySwapResult
}

interface NotFound {
  reason: VerifyReason
  /** The chain that has the transaction but no receipt yet; or the named chain; else null. */
  chainId: number | null
  /** Every chain of the list was asked and none has the transaction (each answered "no such transaction"). */
  absent: boolean
}

/**
 * Asks the chains in turn; stops at the first that has the transaction (an answer other than "no such transaction").
 * `notFound` carries the chain that has the transaction but not yet its receipt, when there is one.
 */
async function searchChains(args: ConfirmArgs, candidates: readonly PendingCandidate[], deps: ConfirmDeps): Promise<{ found: Found } | { notFound: NotFound }> {
  const chains = chainsToAsk(args.chainId, candidates)
  const named = chains.length === 1 && args.chainId !== undefined && args.chainId !== null
  const started = Date.now()
  const elapsed = deps.elapsedMs ?? (() => Date.now() - started)
  let reason: VerifyReason = 'tx_missing'
  let asked = 0
  for (let i = 0; i < chains.length; i++) {
    if (i > 0 && elapsed() >= CHAIN_SEARCH_BUDGET_MS) break
    const chainId = chains[i]
    // The wallet's POST rows on this chain, newest first: tie-breaks only (H.2, H.3).
    const pending = candidates.filter((r) => r.chain_id === chainId && !isClaimRow(r)).map((r) => ({ source: r.source, tokenIn: r.token_in, tokenOut: r.token_out }))
    const result = await verifySwapOnChain({ chainId, txHash: args.txHash, wallet: args.wallet, pending }, { read: deps.read, beforeUpstream: deps.beforeUpstream })
    asked++
    if (result.outcome !== 'not_found') return { found: { chainId, result } }
    // Q.3: this chain returned the transaction, and its receipt is missing, errored or unreadable: this is its chain, and
    // no other chain is asked.
    if (result.txFound) return { notFound: { reason: result.reason ?? 'rpc_error', chainId, absent: false } }
    // Q.2: the read budget is spent: nothing more is asked.
    if (result.reason === 'read_budget') return { notFound: { reason: 'read_budget', chainId: named ? chains[0] : null, absent: false } }
    // An RPC failure is the more useful reason to report than "not on the other chains".
    if (result.reason !== 'tx_missing' || reason === 'tx_missing') reason = result.reason ?? 'rpc_error'
  }
  return { notFound: { reason, chainId: named ? chains[0] : null, absent: asked === chains.length && reason === 'tx_missing' } }
}

/** I.2 / P.2: the row the result goes to, or null (a new row is inserted). */
function chooseRow(
  candidates: readonly PendingCandidate[],
  chainId: number,
  outcome: 'confirmed' | 'failed',
  derived: DerivedSwap,
  callTokenIn: string | null | undefined,
): PendingCandidate | null {
  const matchToken = derived.tokenIn ?? (outcome === 'failed' ? (callTokenIn ?? null) : null)
  const agrees = (row: PendingCandidate) => {
    if (row.chain_id !== chainId || isClaimRow(row)) return false
    if (matchToken !== null) return row.token_in !== null && row.token_in.toLowerCase() === matchToken
    // A reverted call that names no token (owner, 2026-11-26): the same source.
    return outcome === 'failed' && row.source === derived.source
  }
  // The newest POST row that agrees receives the result (and keeps its slippage and expected_output).
  const post = candidates.find(agrees)
  if (post) return post
  // Else a claim row of THIS hash (the only claim rows among the candidates) becomes the verified row: the one that
  // named this chain, else one that named none, else any.
  const claims = candidates.filter(isClaimRow)
  return claims.find((r) => r.claimed_chain_id === chainId) ?? claims.find((r) => r.claimed_chain_id === null) ?? claims[0] ?? null
}

/** Where a claim went: `stored` (a new claim row), `exists` (this key has one), `cap` (P.3: not stored), or a failure. */
type KeepResult = 'stored' | 'exists' | 'cap' | 'columns_missing' | 'error'

/**
 * P.1 and P.3: keep the hash on a claim row of its own, one per (wallet, claimed chain or none, hash). A repeat does
 * not move `claimed_at` (owner's answer of 2026-11-26). At CLAIM_CAP live claims, the chain is first asked about at most
 * CLAIM_CHECKS_PER_REQUEST of the wallet's claims older than CLAIM_CHECK_AFTER_MS (decideClaim); still at the cap: the
 * new claim is not stored.
 */
async function keepClaim(args: ConfirmArgs, candidates: readonly PendingCandidate[], chainId: number | null, now: Date, deps: ConfirmDeps): Promise<KeepResult> {
  if (candidates.some((r) => isClaimRow(r) && r.claimed_chain_id === chainId)) return 'exists'

  // P.3: a claim older than 7 days may be deleted by any later request of that wallet.
  await deleteExpiredClaims(args.db, args.wallet, now)
  const claims = await findClaimRows(args.db, args.wallet)
  if (claims === 'error') return 'error'
  let live = claims.length
  if (live >= CLAIM_CAP) {
    const due = claims.filter((c) => time(c.claimed_at) < now.getTime() - CLAIM_CHECK_AFTER_MS).slice(0, CLAIM_CHECKS_PER_REQUEST)
    for (const claim of due) {
      const decided = await decideClaim(args.db, args.wallet, claim, now, deps)
      if (decided === 'gone') live--
      // Q.2: the cap check's reads are charged to the same budget; spent, no further claim is asked about.
      if (decided === 'budget') break
    }
  }
  if (live >= CLAIM_CAP) return 'cap'

  const inserted = await insertClaimRow(args.db, {
    id: randomUUID(),
    wallet: args.wallet,
    // A claim that names no chain sits on the registry's first chain; claimed_chain_id says null.
    chain_id: chainId ?? getSupportedChainIds()[0],
    source: UNKNOWN_SOURCE,
    claimed_tx_hash: args.txHash,
    claimed_chain_id: chainId,
    claimed_at: now.toISOString(),
  })
  return inserted === 'inserted' ? 'stored' : inserted
}

/**
 * P.3: the chain decides one of the wallet's claims. The transaction found: verified and recorded now (or, not this
 * wallet's swap, its claims deleted). Found on no chain (every chain asked said "no such transaction"): that claim row
 * is deleted. Anything else (no receipt yet, an RPC error, a read refused): the claim stays. `gone`: the claim no longer
 * takes a place.
 */
async function decideClaim(db: SupabaseClient, wallet: string, claim: ClaimRow, now: Date, deps: ConfirmDeps): Promise<'gone' | 'kept' | 'budget'> {
  const txHash = claim.claimed_tx_hash.toLowerCase()
  const args: ConfirmArgs = { db, wallet, txHash, chainId: claim.claimed_chain_id }
  const already = await findWalletVerifiedByTx(db, wallet, txHash)
  if (already === 'error') return 'kept'
  if (already) {
    await deleteClaimsOf(db, wallet, txHash)
    return 'gone'
  }
  const candidates = await findCandidateRows(db, wallet, txHash, new Date(now.getTime() - PENDING_MATCH_WINDOW_MS).toISOString())
  if (candidates === 'error') return 'kept'
  const searched = await searchChains(args, candidates, deps)
  if ('notFound' in searched) {
    if (searched.notFound.reason === 'read_budget') return 'budget'
    if (!searched.notFound.absent) return 'kept'
    return (await deleteClaimRow(db, wallet, claim.id)) ? 'gone' : 'kept'
  }
  const recorded = await recordFound(args, candidates, searched.found, now, deps)
  return recorded.result === 'verified' || recorded.result === 'rejected' ? 'gone' : 'kept'
}

/**
 * Details I. Never throws for a chain or storage answer; the caller maps the result to its HTTP status.
 */
export async function confirmSwap(args: ConfirmArgs, deps: ConfirmDeps = {}): Promise<ConfirmResult> {
  const now = (deps.now ?? (() => new Date()))()

  // This wallet already has this transaction verified: nothing to read, nothing to write.
  const already = await findWalletVerifiedByTx(args.db, args.wallet, args.txHash)
  if (already === 'error') return { result: 'storage_error' }
  if (already) return { result: 'verified' }

  const candidates = await findCandidateRows(args.db, args.wallet, args.txHash, new Date(now.getTime() - PENDING_MATCH_WINDOW_MS).toISOString())
  if (candidates === 'error') return { result: 'storage_error' }

  const searched = await searchChains(args, candidates, deps)
  if ('notFound' in searched) {
    const kept = await keepClaim(args, candidates, searched.notFound.chainId, now, deps)
    if (kept === 'columns_missing') return { result: 'columns_missing' }
    // One line each, fixed words only. `swap_claim_cap`: the wallet holds CLAIM_CAP claims the chain could not retire.
    if (kept === 'cap') console.warn('[log-swap] swap_claim_cap')
    if (kept === 'error') console.warn('[log-swap] claim not stored')
    return { result: 'not_found', reason: searched.notFound.reason, claimed: kept === 'stored' || kept === 'exists' }
  }
  return recordFound(args, candidates, searched.found, now, deps)
}

/** The chain answered for `args.txHash`: rejected (its claims deleted), or the result written (I.2, P.2). */
async function recordFound(args: ConfirmArgs, candidates: readonly PendingCandidate[], found: Found, now: Date, deps: ConfirmDeps): Promise<ConfirmResult> {
  const { chainId, result: verified } = found
  const claimRows = candidates.filter(isClaimRow)
  if (verified.outcome === 'rejected' || !verified.kind || !verified.derived) {
    const reason = verified.reason ?? 'wrong_target'
    // The chain answered: the claims of this hash are decided.
    if (claimRows.length > 0) await deleteClaimsOf(args.db, args.wallet, args.txHash)
    // One line, fixed words only: the reason is one of verify-swap-on-chain.ts's codes, the chain is one of the app's.
    console.warn(`[log-swap] verification rejected reason=${forLog(reason)} chain=${forLog(chainId)}`)
    return { result: 'rejected', reason }
  }

  const outcome = verified.outcome as 'confirmed' | 'failed'
  const derived = verified.derived

  // [ADR-029 9.1, A106 R3-1; replaces 8.5 (owner's decision of 2026-11-27)] A row main stored for this transaction
  // stands for it and is READ-ONLY for a request: no column of it changes and no row is inserted beside it, whether
  // what it stores agrees with the receipt or not. Only the stored-rows script with --apply marks it, after the owner
  // read its report (which lists its caller columns). The answer is the transaction's own: verified. No tracker runs.
  const mainRow = await hasMainRow(args.db, args.wallet, chainId, args.txHash)
  if (mainRow === 'error') return { result: 'storage_error' }
  if (mainRow) {
    // The chain answered: this hash's claim rows are decided (round 3's claim rule; owner's answer of 2026-11-27).
    if (claimRows.length > 0) await deleteClaimsOf(args.db, args.wallet, args.txHash)
    return { result: 'verified' }
  }

  const [usdIn, usdOut] = await Promise.all([usdOfSide(chainId, derived.tokenIn, derived.amountIn), usdOfSide(chainId, derived.tokenOut, derived.amountOut)])
  // O.2: a router row's ETH in side is the transaction value (verify-swap-on-chain.ts: only with a derived out side).
  // Its USD counts only when what came back for it is worth about as much; otherwise neither side carries USD.
  const ethIn = verified.kind === 'router' && derived.tokenIn === NATIVE_PLACEHOLDER
  const usd = ethIn ? ethInUsd(usdIn, usdOut) : { in: usdIn, out: usdOut }
  const usdWithheld = ethIn && usd.in === null
  const update = buildUpdate(args.txHash, outcome, verified.kind, chainId, derived, usd, now)

  const row = chooseRow(candidates, chainId, outcome, derived, verified.callTokenIn)
  let written: 'updated' | 'inserted' | 'not_unverified' | 'duplicate' | 'columns_missing' | 'error'
  if (row !== null) written = await markVerified(args.db, row.id, args.wallet, update, isClaimRow(row) ? chainId : undefined)
  else written = await insertVerified(args.db, { id: randomUUID(), wallet: args.wallet, chain_id: chainId, ...update })
  // The row went to another transaction a moment ago (a race on the same pending row): the transaction makes its own.
  if (written === 'not_unverified') written = await insertVerified(args.db, { id: randomUUID(), wallet: args.wallet, chain_id: chainId, ...update })

  if (written === 'columns_missing') return { result: 'columns_missing' }
  if (written === 'error') return { result: 'storage_error' }
  // The claim rows of this hash that were not just written (a claim row the update reused no longer holds its claim).
  const leftClaims = claimRows.some((r) => written !== 'updated' || r.id !== row?.id)
  if (written === 'duplicate') {
    // The index refused it: another request of this wallet recorded this transaction a moment ago, or it did not.
    const again = await findWalletVerifiedByTx(args.db, args.wallet, args.txHash)
    if (again !== true) return { result: 'duplicate' }
    if (leftClaims) await deleteClaimsOf(args.db, args.wallet, args.txHash)
    return { result: 'verified' }
  }

  // The claim is decided: the claim rows of this hash are deleted (a claim row holds nothing else).
  if (leftClaims) await deleteClaimsOf(args.db, args.wallet, args.txHash)
  if (deps.trackers !== false) runTrackers(args.wallet, args.txHash, update, { in: usdIn, out: usdOut }, usdWithheld)
  return { result: 'verified' }
}
