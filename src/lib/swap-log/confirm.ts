/**
 * [ADR-029, details C] Confirming a swap row: the server reads the transaction on the ROW's chain and, only when the
 * chain says so, writes status, hash, the derived tokens, amounts, symbols, USD and gas in ONE update.
 *
 * Nothing in the update comes from the caller: the wallet and the hash are the two values the chain was asked about,
 * every other column is derived (verify-swap-on-chain.ts), priced by the server from the DERIVED amounts, looked up in
 * the token catalog, or cleared. The trackers (large trade, oracle, failed swap) run here, after the update, from the
 * same derived values.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { computeTokenAmountUsd } from '@/lib/chainlink'
import { getWrappedNative } from '@/lib/chains/registry'
import { forLog } from '@/lib/log-sanitize'
import { trackLargeTrade, trackOracleDeviation, trackOracleUnavailable, trackSwapFailed } from '@/lib/security-tracker'
import {
  NATIVE_PLACEHOLDER,
  verifySwapOnChain,
  type DerivedSwap,
  type VerifiedKind,
  type VerifyDeps,
  type VerifyReason,
} from '@/lib/swap-verify/verify-swap-on-chain'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import {
  PENDING_MATCH_WINDOW_MS,
  findLatestPending,
  findWalletRowById,
  findTxVerifiedElsewhere,
  findWalletRowByTx,
  markVerified,
  type SwapRowRef,
  type VerifiedUpdate,
} from './store'
import { catalogSymbolOrNull } from './symbols'

/** A trade at or above this many USD is recorded as a large trade (monitoring only). */
export const LARGE_TRADE_USD = 50_000
/** The two derived sides differ by at least this fraction of the sold side: recorded as an oracle deviation. */
export const ORACLE_DEVIATION_WARN = 0.02

export type ConfirmResult =
  /** The row is verified now, or already was by this wallet and this transaction. */
  | { result: 'verified' }
  /** This wallet has no row this transaction could confirm. */
  | { result: 'no_row' }
  /** The chain has no such transaction or receipt (yet), or could not be read: the row is unchanged. */
  | { result: 'not_found'; reason: VerifyReason }
  /** The transaction is not this row's swap: the row is unchanged. */
  | { result: 'rejected'; reason: VerifyReason }
  /** This (chain, transaction) already verified another row: nothing changes. */
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
  }
}

/** After a verified update: the trackers, from derived values only. Fire-and-forget, as the trackers are. */
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
}

export interface ConfirmArgs {
  /** The service-role client: the lookups and the one UPDATE. */
  db: SupabaseClient
  /** Lowercase, validated. */
  wallet: string
  /** Lowercase, validated. */
  txHash: string
  /** When set, only this row (which must belong to `wallet`) may be confirmed: the row a POST just inserted. */
  rowId?: string
}

/** A row is only ever this wallet's. The lookups are already scoped to the wallet; this is the second lock on that door. */
function ownRow<T extends SwapRowRef | null | 'error'>(row: T, wallet: string): T | null {
  if (row === null || row === 'error') return row
  return row.wallet.toLowerCase() === wallet ? row : null
}

async function chooseRow(args: ConfirmArgs, now: Date): Promise<SwapRowRef | null | 'verified' | 'error'> {
  // 1. The row of THAT wallet that already carries this hash.
  const byTx = ownRow(await findWalletRowByTx(args.db, args.wallet, args.txHash), args.wallet)
  if (byTx === 'error') return 'error'
  if (byTx !== null) return byTx.verified_at !== null ? 'verified' : byTx

  // 2. The row a POST just inserted, or else the latest pending row of THAT wallet in the last two hours.
  if (args.rowId !== undefined) return ownRow(await findWalletRowById(args.db, args.wallet, args.rowId), args.wallet)
  return ownRow(await findLatestPending(args.db, args.wallet, new Date(now.getTime() - PENDING_MATCH_WINDOW_MS).toISOString()), args.wallet)
}

/**
 * Details C. Never throws for a chain or storage answer; the caller maps the result to its HTTP status.
 */
export async function confirmSwap(args: ConfirmArgs, deps: ConfirmDeps = {}): Promise<ConfirmResult> {
  const now = (deps.now ?? (() => new Date()))()

  const row = await chooseRow(args, now)
  if (row === 'error') return { result: 'storage_error' }
  if (row === 'verified') return { result: 'verified' }
  if (row === null) return { result: 'no_row' }
  if (row.verified_at !== null) return { result: 'verified' }

  // One transaction, one row: asked before any chain read, and enforced again by the database on the update.
  // When the row it already verified is this wallet's own (two confirmations of one swap arriving together, the second
  // of which found an older pending row), the swap is recorded and nothing changes; another wallet's is a duplicate.
  const elsewhere = await findTxVerifiedElsewhere(args.db, row.chain_id, args.txHash, row.id, args.wallet)
  if (elsewhere === 'error') return { result: 'storage_error' }
  if (elsewhere !== null) return elsewhere.wallet === args.wallet ? { result: 'verified' } : { result: 'duplicate' }

  // The ROW's chain and source decide what is read and what counts.
  const verified = await verifySwapOnChain({ chainId: row.chain_id, txHash: args.txHash, wallet: args.wallet, pending: [{ source: row.source }] }, { read: deps.read })
  if (verified.outcome === 'not_found') return { result: 'not_found', reason: verified.reason ?? 'rpc_error' }
  if (verified.outcome === 'rejected' || !verified.kind || !verified.derived) {
    const reason = verified.reason ?? 'wrong_target'
    // One line, fixed words only: the reason is one of verify-swap-on-chain.ts's codes, the chain is the row's.
    console.warn(`[log-swap] verification rejected reason=${forLog(reason)} chain=${forLog(row.chain_id)}`)
    return { result: 'rejected', reason }
  }

  const derived = verified.derived
  const [usdIn, usdOut] = await Promise.all([
    usdOfSide(row.chain_id, derived.tokenIn, derived.amountIn),
    usdOfSide(row.chain_id, derived.tokenOut, derived.amountOut),
  ])
  const update = buildUpdate(args.txHash, verified.outcome, verified.kind, row.chain_id, derived, { in: usdIn, out: usdOut }, now)

  const marked = await markVerified(args.db, row.id, args.wallet, update)
  if (marked === 'columns_missing') return { result: 'columns_missing' }
  if (marked === 'error') return { result: 'storage_error' }
  if (marked === 'duplicate' || marked === 'not_unverified') {
    // Lost a race. `duplicate`: the database's unique index refused this (chain, hash). `not_unverified`: another
    // request verified this row first. Either way, if this wallet now has a verified row for this transaction the swap
    // is recorded; if not, the index says another row has it (duplicate), or this row went to another transaction.
    const again = await findWalletRowByTx(args.db, args.wallet, args.txHash)
    if (again !== null && again !== 'error' && again.verified_at !== null) return { result: 'verified' }
    return marked === 'duplicate' ? { result: 'duplicate' } : { result: 'no_row' }
  }

  runTrackers(args.wallet, args.txHash, update)
  return { result: 'verified' }
}
