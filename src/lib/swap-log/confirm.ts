/**
 * [ADR-029 section 7.2 and 7.3, details I of goal 133b] A confirmation: THE TRANSACTION MAKES THE ROW.
 *
 * A confirmation carries a wallet, a transaction hash and, when the client knows it, the chain. The server reads the
 * transaction on the candidate chains (verify-swap-on-chain.ts) and takes kind, source, tokens and amounts from the
 * chain. Then:
 *   confirmed / failed  the result goes to the newest pending row of THAT wallet on that chain that agrees with it (same
 *                       in token; for a reverted call that names no token, the same source), the row holding this
 *                       claim first; if none agrees, a new verified row is inserted. Either way the row carries only
 *                       derived values plus the wallet and the hash (slippage and expected_output of an updated pending
 *                       row stay: owner's answer of 2026-11-25, kept on 2026-11-26).
 *   not_found           the hash is never thrown away: it is kept as a PRIVATE claim on a pending row of the wallet (one
 *                       that holds no claim yet), or on a new claim row; the caller answers 202 and the client asks again.
 *   rejected            the chain answered and it is not this wallet's swap: a claim of that hash is cleared.
 * Pending rows are private scratch: they are hints for the chain read (a tie-break) and places to attach, never proof.
 *
 * Nothing written comes from the caller but the wallet and the hash the chain was asked about (and, in a claim, the
 * chain the caller named). The trackers (large trade, oracle, failed swap) run after the write, from derived values.
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
  PENDING_MATCH_WINDOW_MS,
  clearClaim,
  findCandidateRows,
  findWalletVerifiedByTx,
  insertClaimRow,
  insertVerified,
  makeRoomForPending,
  markVerified,
  setClaimChain,
  storeClaimOn,
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

/** After a verified write: the trackers, from derived values only. Fire-and-forget, as the trackers are. */
function runTrackers(wallet: string, txHash: string, update: VerifiedUpdate): void {
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
  if (update.amount_in_usd !== null && update.amount_out_usd !== null && update.amount_in_usd > 0) {
    const deviation = Math.abs(update.amount_in_usd - update.amount_out_usd) / update.amount_in_usd
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

const sameHash = (a: string | null, b: string) => a !== null && a.toLowerCase() === b

/** A claim row: written by a confirmation for its claim alone; a POST row always has its two tokens. */
const isClaimRow = (row: PendingCandidate) => row.token_in === null

/**
 * H.5: the chains to ask, in order. The chain the client named; else the chains of the wallet's pending rows (newest
 * first), then the app's other chains in the registry's order (owner's answer of 2026-11-26: all chains).
 */
function chainsToAsk(chainId: number | null | undefined, candidates: readonly PendingCandidate[]): number[] {
  if (chainId !== undefined && chainId !== null && isSwapLogChain(chainId)) return [chainId]
  const order: number[] = []
  for (const row of candidates) if (isSwapLogChain(row.chain_id) && !order.includes(row.chain_id)) order.push(row.chain_id)
  for (const chain of getSupportedChainIds()) if (!order.includes(chain)) order.push(chain)
  return order
}

interface Found {
  chainId: number
  result: VerifySwapResult
}

/**
 * Asks the chains in turn; stops at the first that has the transaction (an answer other than "no such transaction").
 * `notFound` carries the chain that has the transaction but not yet its receipt, when there is one.
 */
async function searchChains(
  args: ConfirmArgs,
  candidates: readonly PendingCandidate[],
  deps: ConfirmDeps,
): Promise<{ found: Found } | { notFound: { reason: VerifyReason; chainId: number | null } }> {
  const chains = chainsToAsk(args.chainId, candidates)
  const named = chains.length === 1 && args.chainId !== undefined && args.chainId !== null
  const started = Date.now()
  const elapsed = deps.elapsedMs ?? (() => Date.now() - started)
  let reason: VerifyReason = 'tx_missing'
  for (let i = 0; i < chains.length; i++) {
    if (i > 0 && elapsed() >= CHAIN_SEARCH_BUDGET_MS) break
    const chainId = chains[i]
    // The wallet's pending rows on this chain, newest first: tie-breaks only (H.2, H.3).
    const pending = candidates.filter((r) => r.chain_id === chainId && !isClaimRow(r)).map((r) => ({ source: r.source, tokenIn: r.token_in, tokenOut: r.token_out }))
    const result = await verifySwapOnChain({ chainId, txHash: args.txHash, wallet: args.wallet, pending }, { read: deps.read })
    if (result.outcome !== 'not_found') return { found: { chainId, result } }
    // The transaction is there but its receipt is not yet: this is its chain.
    if (result.reason === 'receipt_missing') return { notFound: { reason: 'receipt_missing', chainId } }
    // An RPC failure is the more useful reason to report than "not on the other chains".
    if (result.reason !== 'tx_missing' || reason === 'tx_missing') reason = result.reason ?? 'rpc_error'
  }
  return { notFound: { reason, chainId: named ? chains[0] : null } }
}

/** I.2: the row the result goes to, or null (a new row is inserted). */
function chooseRow(
  candidates: readonly PendingCandidate[],
  txHash: string,
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
  const holder = candidates.find((r) => sameHash(r.claimed_tx_hash, txHash))
  // The row that holds this claim: a claim row was written for it alone; a POST row only if it agrees.
  if (holder && (isClaimRow(holder) || agrees(holder))) return holder
  // Else the newest that agrees and holds no claim of another transaction.
  return candidates.find((r) => (r.claimed_tx_hash === null || sameHash(r.claimed_tx_hash, txHash)) && agrees(r)) ?? null
}

/** I.4: keep the hash. Never overwrites another claim. `false`: it could not be stored (the caller still answers 202). */
async function keepClaim(args: ConfirmArgs, candidates: readonly PendingCandidate[], chainId: number | null, now: Date): Promise<boolean | 'columns_missing'> {
  const holder = candidates.find((r) => sameHash(r.claimed_tx_hash, args.txHash))
  if (holder) {
    if (holder.claimed_chain_id === null && chainId !== null) await setClaimChain(args.db, holder.id, args.wallet, chainId)
    return true
  }
  const claim = { claimed_tx_hash: args.txHash, claimed_chain_id: chainId, claimed_at: now.toISOString() }
  // The newest POST row of that wallet (on that chain when it is known) that holds no claim yet.
  for (const row of candidates) {
    if (isClaimRow(row) || row.claimed_tx_hash !== null) continue
    if (chainId !== null && row.chain_id !== chainId) continue
    const stored = await storeClaimOn(args.db, row.id, args.wallet, claim)
    if (stored === 'stored') return true
    if (stored === 'columns_missing') return 'columns_missing'
    if (stored === 'error') return false
  }
  // None: a claim row of its own, after making room for it (details J). Its chain_id is the named chain, else the
  // registry's first (claimed_chain_id says null).
  if ((await makeRoomForPending(args.db, args.wallet, now)) === 'error') console.warn('[log-swap] pending cap not applied')
  const inserted = await insertClaimRow(args.db, {
    id: randomUUID(),
    wallet: args.wallet,
    chain_id: chainId ?? getSupportedChainIds()[0],
    source: UNKNOWN_SOURCE,
    ...claim,
  })
  if (inserted === 'columns_missing') return 'columns_missing'
  return inserted === 'inserted'
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
    const kept = await keepClaim(args, candidates, searched.notFound.chainId, now)
    if (kept === 'columns_missing') return { result: 'columns_missing' }
    if (!kept) console.warn('[log-swap] claim not stored')
    return { result: 'not_found', reason: searched.notFound.reason, claimed: kept }
  }

  const { chainId, result: verified } = searched.found
  if (verified.outcome === 'rejected' || !verified.kind || !verified.derived) {
    const reason = verified.reason ?? 'wrong_target'
    // The chain answered: a claim of this hash is decided.
    if (candidates.some((r) => sameHash(r.claimed_tx_hash, args.txHash))) await clearClaim(args.db, args.wallet, args.txHash)
    // One line, fixed words only: the reason is one of verify-swap-on-chain.ts's codes, the chain is one of the app's.
    console.warn(`[log-swap] verification rejected reason=${forLog(reason)} chain=${forLog(chainId)}`)
    return { result: 'rejected', reason }
  }

  const outcome = verified.outcome as 'confirmed' | 'failed'
  const derived = verified.derived
  const [usdIn, usdOut] = await Promise.all([usdOfSide(chainId, derived.tokenIn, derived.amountIn), usdOfSide(chainId, derived.tokenOut, derived.amountOut)])
  const update = buildUpdate(args.txHash, outcome, verified.kind, chainId, derived, { in: usdIn, out: usdOut }, now)

  const row = chooseRow(candidates, args.txHash, chainId, outcome, derived, verified.callTokenIn)
  let written: 'updated' | 'inserted' | 'not_unverified' | 'duplicate' | 'columns_missing' | 'error'
  if (row !== null) written = await markVerified(args.db, row.id, args.wallet, update, isClaimRow(row) ? chainId : undefined)
  else written = await insertVerified(args.db, { id: randomUUID(), wallet: args.wallet, chain_id: chainId, ...update })
  // The row went to another transaction a moment ago (a race on the same pending row): the transaction makes its own.
  if (written === 'not_unverified') written = await insertVerified(args.db, { id: randomUUID(), wallet: args.wallet, chain_id: chainId, ...update })

  if (written === 'columns_missing') return { result: 'columns_missing' }
  if (written === 'error') return { result: 'storage_error' }
  const heldElsewhere = candidates.some((r) => sameHash(r.claimed_tx_hash, args.txHash) && (written !== 'updated' || r.id !== row?.id))
  if (written === 'duplicate') {
    // The index refused it: another request of this wallet recorded this transaction a moment ago, or it did not.
    const again = await findWalletVerifiedByTx(args.db, args.wallet, args.txHash)
    if (again !== true) return { result: 'duplicate' }
    if (heldElsewhere) await clearClaim(args.db, args.wallet, args.txHash)
    return { result: 'verified' }
  }

  // The claim is decided: cleared on the row just written (the update did it) and on any other row that held it.
  if (heldElsewhere) await clearClaim(args.db, args.wallet, args.txHash)
  if (deps.trackers !== false) runTrackers(args.wallet, args.txHash, update)
  return { result: 'verified' }
}
