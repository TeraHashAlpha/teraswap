/**
 * [FEAT-DCA-SETTLEMENT-RECEIPT] Settlement receipt resolver for a completed/cancelled DCA position.
 *
 * Assembles per-fill rows from Supabase (which fill tx hashes exist, in what order) enriched with
 * the EXACT amounts from the on-chain `OrderExecuted` event, decoded fresh from each fill's tx
 * receipt — never trusted from (or recomputed against) any Supabase copy. This is the "radical
 * transparency" accuracy invariant: protocol-fee figures come from the event's `fee` field only.
 *
 * "Network cost" (gasUsed × effectiveGasPrice + any L2 L1-data-fee) is v3 keeper-paid — labelled via
 * the ONE constant below (NETWORK_COST_LABEL). ADR-015 (v4, user-pays-gas) will change only that
 * string; nothing else here needs to change when that ships.
 *
 * Data is immutable once a position reaches a terminal state (completed/cancelled), so results are
 * cached in-memory per orderHash — a repeat "View receipt" open never re-fetches.
 */

import { decodeEventLog, formatUnits, type Address, type Hex, type PublicClient } from 'viem'
import { getPublicClientForChain } from '@/lib/chains/clients'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { getOrderExecutor, getOrderExecutorV3 } from '@/lib/order-engine'

// ── Label — single source of truth [FEAT-DCA-SETTLEMENT-RECEIPT] ──
// v3 truth: the keeper's own wallet pays every fill's gas; the user pays nothing beyond the
// protocol fee. When v4 (ADR-015, user-pays-gas estimate-with-cap) ships, this ONE string changes
// to something like "Paid by you, capped at $X" — no other code in this module or its UI consumers
// needs to change for that wording flip.
export const NETWORK_COST_LABEL = 'Network cost — covered by TeraSwap'

// OrderExecuted(bytes32 indexed orderHash, address indexed owner, uint8 indexed orderType,
//               address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee)
// Identical event shape on TeraSwapOrderExecutor (v2) and TeraSwapOrderExecutorV3 — one ABI decodes
// either contract's log. Mirrors contracts/order-engine/executor/record-execution.js's
// ORDER_EXECUTED_EVENT (the keeper's own decoder for this exact event).
const ORDER_EXECUTED_EVENT = {
  type: 'event',
  name: 'OrderExecuted',
  inputs: [
    { name: 'orderHash', type: 'bytes32', indexed: true },
    { name: 'owner', type: 'address', indexed: true },
    { name: 'orderType', type: 'uint8', indexed: true },
    { name: 'tokenIn', type: 'address', indexed: false },
    { name: 'tokenOut', type: 'address', indexed: false },
    { name: 'amountIn', type: 'uint256', indexed: false },
    { name: 'amountOut', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
  ],
} as const

export interface DecodedOrderExecuted {
  orderHash: Hex
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  amountOut: bigint
  fee: bigint
}

/** A single receipt log, typed loosely enough to accept both viem's real `Log` and test fixtures. */
export interface ReceiptLogLike {
  address: string
  data: Hex
  topics: readonly Hex[]
}

/**
 * Decode one log as `OrderExecuted`, or null if it isn't one (e.g. an ERC-20 Transfer from the
 * same tx — `decodeEventLog` throws on a topic0 mismatch, which we treat as "not this event").
 * When `allowedAddresses` is non-empty, the log's emitting contract must be one of them — the same
 * defensive address check `record-execution.js` performs, generalized here to accept BOTH v2 and
 * v3 executor addresses (a fill can come from either contract depending on when it was signed).
 */
export function decodeOrderExecutedLog(
  log: ReceiptLogLike,
  allowedAddresses: readonly string[] = [],
): DecodedOrderExecuted | null {
  if (allowedAddresses.length > 0) {
    const target = log.address.toLowerCase()
    if (!allowedAddresses.some((a) => a.toLowerCase() === target)) return null
  }
  try {
    const decoded = decodeEventLog({
      abi: [ORDER_EXECUTED_EVENT],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    })
    if (decoded.eventName !== 'OrderExecuted') return null
    const a = decoded.args
    return {
      orderHash: a.orderHash,
      tokenIn: a.tokenIn,
      tokenOut: a.tokenOut,
      amountIn: a.amountIn,
      amountOut: a.amountOut,
      fee: a.fee,
    }
  } catch {
    return null
  }
}

/** Effective price for a single fill: input spent per unit of output received (cost basis),
 *  decimals-adjusted — same convention as `position-stats.ts`'s `avgBuyPrice`. Null when the fill
 *  received nothing (division by zero would be meaningless, not "free"). */
export function computeEffectivePrice(
  amountInRaw: bigint,
  amountOutRaw: bigint,
  tokenInDecimals: number,
  tokenOutDecimals: number,
): number | null {
  if (amountOutRaw <= 0n) return null
  const investedHuman = Number(formatUnits(amountInRaw, tokenInDecimals))
  const receivedHuman = Number(formatUnits(amountOutRaw, tokenOutDecimals))
  return receivedHuman > 0 ? investedHuman / receivedHuman : null
}

/** Network cost for one fill's tx: gasUsed × effectiveGasPrice, plus any L2 L1-data-fee the chain's
 *  RPC surfaces on the receipt (Optimism-stack chains like Base extend the receipt with `l1Fee`;
 *  viem's base `TransactionReceipt` type doesn't declare it, so it's read defensively). */
export function computeNetworkCostWei(receipt: {
  gasUsed: bigint
  effectiveGasPrice: bigint
  l1Fee?: bigint | null
}): bigint {
  const l1Fee = typeof receipt.l1Fee === 'bigint' ? receipt.l1Fee : 0n
  return receipt.gasUsed * receipt.effectiveGasPrice + l1Fee
}

export interface FillReceipt {
  executionNumber: number
  txHash: string
  txUrl: string
  /** Unix ms, or null if neither the block timestamp nor a Supabase fallback was available. */
  timestamp: number | null
  amountInRaw: string
  amountOutRaw: string
  effectivePrice: number | null
  /** Exact — from the on-chain `OrderExecuted` event's `fee` field. Never recomputed. */
  protocolFeeRaw: string
  networkCostWeiRaw: string
  /** [CHORE-DCA-AGGREGATION-VALUE] Runner-up (second-best) source's gross output, raw token
   *  units — passed through verbatim from the keeper's `order_executions.next_best_out`
   *  (additive telemetry, no on-chain event carries it). Null = no comparison available for
   *  this fill (single-source quote round, a fetch failure, or a pre-migration row) — render
   *  "—", never a fabricated number. */
  nextBestOutRaw: string | null
  /** The runner-up's aggregator name (e.g. "1inch"), or null alongside `nextBestOutRaw`. */
  nextBestSource: string | null
  /** max(0, amountOutRaw - nextBestOutRaw), or null when nextBestOutRaw is null. Clamped at 0
   *  (never negative) — see computeAggregationValueRaw's own doc for why. */
  aggregationValueRaw: string | null
}

export interface SettlementTotals {
  totalInvestedRaw: string
  totalReceivedRaw: string
  avgPrice: number | null
  totalProtocolFeeRaw: string
  totalNetworkCostWeiRaw: string
  /** [CHORE-DCA-AGGREGATION-VALUE] Sum of every fill's `aggregationValueRaw` that had one — null
   *  (not "0") when NO fill in the position has any comparison data at all, so the UI can render
   *  an honest "—" rather than a fabricated total of zero. */
  totalAggregationValueRaw: string | null
}

/**
 * [CHORE-DCA-AGGREGATION-VALUE] The "aggregation value" TeraSwap's routing delivered for one
 * fill: our executed output vs the next-best source's output from the same quote round,
 * gross-vs-gross. Clamped at 0 rather than allowed negative: the deviation guard bounds how far
 * the committed route can drift, but nothing guarantees it beats literally every quote every
 * round, and a negative "value" would be both dishonest-looking and needlessly demoralizing —
 * "no measurable value this round" (0) is the accurate, honest statement in that case. Null
 * (never 0) when there was no runner-up to compare against at all.
 */
export function computeAggregationValueRaw(
  amountOutRaw: string,
  nextBestOutRaw: string | null,
): string | null {
  if (nextBestOutRaw == null) return null
  try {
    const diff = BigInt(amountOutRaw) - BigInt(nextBestOutRaw)
    return diff > 0n ? diff.toString() : '0'
  } catch {
    return null
  }
}

/** Sums are pure BigInt arithmetic over already-resolved `FillReceipt`s — no chain access, fully
 *  unit-testable against fixtures. */
export function computeSettlementTotals(
  fills: readonly FillReceipt[],
  opts: { tokenInDecimals: number; tokenOutDecimals: number },
): SettlementTotals {
  let investedRaw = 0n
  let receivedRaw = 0n
  let feeRaw = 0n
  let networkCostRaw = 0n
  let aggregationValueRaw = 0n
  let anyAggregationValue = false
  for (const f of fills) {
    investedRaw += BigInt(f.amountInRaw)
    receivedRaw += BigInt(f.amountOutRaw)
    feeRaw += BigInt(f.protocolFeeRaw)
    networkCostRaw += BigInt(f.networkCostWeiRaw)
    if (f.aggregationValueRaw != null) {
      anyAggregationValue = true
      aggregationValueRaw += BigInt(f.aggregationValueRaw)
    }
  }
  const invested = Number(formatUnits(investedRaw, opts.tokenInDecimals))
  const received = Number(formatUnits(receivedRaw, opts.tokenOutDecimals))
  return {
    totalInvestedRaw: investedRaw.toString(),
    totalReceivedRaw: receivedRaw.toString(),
    avgPrice: received > 0 ? invested / received : null,
    totalProtocolFeeRaw: feeRaw.toString(),
    totalNetworkCostWeiRaw: networkCostRaw.toString(),
    totalAggregationValueRaw: anyAggregationValue ? aggregationValueRaw.toString() : null,
  }
}

export interface EstimateComparison {
  /** The order's signed budget (order_data.maxSlippageBps) — null for a pre-v3 (v2) order that
   *  never signed one. */
  maxSlippageBps: number | null
  /** Realized protocol-fee cost, in bps of total invested — the actual figure the signed budget
   *  bounds TODAY (v3: the oracle floor covers fee + price impact; gas is keeper-paid and outside
   *  the signed bound until ADR-015's v4 makes the cap genuinely all-in). Null with zero invested. */
  realizedFeeBps: number | null
}

export function computeEstimateComparison(
  totals: SettlementTotals,
  opts: { maxSlippageBps?: number | null },
): EstimateComparison {
  const investedRaw = BigInt(totals.totalInvestedRaw)
  const feeRaw = BigInt(totals.totalProtocolFeeRaw)
  const realizedFeeBps = investedRaw > 0n ? Number((feeRaw * 10_000n) / investedRaw) : null
  return { maxSlippageBps: opts.maxSlippageBps ?? null, realizedFeeBps }
}

export type SettlementStatus = 'completed' | 'cancelled'

export interface SettlementReceipt {
  orderHash: string
  status: SettlementStatus
  chainId: number
  tokenInSymbol: string
  tokenOutSymbol: string
  tokenInDecimals: number
  tokenOutDecimals: number
  fills: FillReceipt[]
  totals: SettlementTotals
  estimate: EstimateComparison
  /** Threaded through for convenience so UI never hardcodes the label itself. */
  networkCostLabel: string
}

export interface FillSource {
  executionNumber: number
  txHash: string
  /** Supabase `created_at`/`executed_at` — used ONLY as a timestamp fallback if the on-chain block
   *  read fails; never used for any amount/fee figure. */
  createdAt?: string | null
  /** [CHORE-DCA-AGGREGATION-VALUE] Passed through verbatim from `order_executions.next_best_out`/
   *  `next_best_source` — additive keeper telemetry with no on-chain event to decode, so (unlike
   *  every amount/fee figure above) this is trusted from Supabase directly. Absent/null on any
   *  fill recorded before this feature shipped, or with no runner-up that round. */
  nextBestOutRaw?: string | null
  nextBestSource?: string | null
}

/** Minimal receipt shape this module actually reads — a subset of viem's real `TransactionReceipt`
 *  plus the OP-stack-only `l1Fee` extension, kept loose so test fixtures don't need every field. */
export interface FetchedReceiptLike {
  gasUsed: bigint
  effectiveGasPrice: bigint
  l1Fee?: bigint | null
  blockNumber: bigint
  logs: readonly ReceiptLogLike[]
}

/** Chain client seam — production uses `getPublicClientForChain`; tests inject a fake. */
export interface ReceiptClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<FetchedReceiptLike>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

function asReceiptClient(client: PublicClient): ReceiptClient {
  return client as unknown as ReceiptClient
}

/**
 * Fetch + decode ONE fill's on-chain truth. Returns null when the tx receipt has no decodable
 * `OrderExecuted` log for the given executor address(es) — a defensive skip, never a thrown error,
 * so one bad/unexpected fill row can't blank the whole receipt.
 */
export async function fetchFillReceipt(
  client: ReceiptClient,
  params: {
    chainId: number
    txHash: string
    executionNumber: number
    tokenInDecimals: number
    tokenOutDecimals: number
    executorAddresses: readonly string[]
    fallbackTimestampMs?: number | null
    /** [CHORE-DCA-AGGREGATION-VALUE] Threaded straight through — no on-chain event carries these. */
    nextBestOutRaw?: string | null
    nextBestSource?: string | null
  },
): Promise<FillReceipt | null> {
  const receipt = await client.getTransactionReceipt({ hash: params.txHash as Hex })

  let decoded: DecodedOrderExecuted | null = null
  for (const log of receipt.logs) {
    decoded = decodeOrderExecutedLog(log, params.executorAddresses)
    if (decoded) break
  }
  if (!decoded) return null

  const networkCostWei = computeNetworkCostWei(receipt)

  let timestamp = params.fallbackTimestampMs ?? null
  try {
    const block = await client.getBlock({ blockNumber: receipt.blockNumber })
    timestamp = Number(block.timestamp) * 1000
  } catch {
    // Keep the Supabase fallback (or null) — a stale/unavailable block read must not blank the fill.
  }

  const nextBestOutRaw = params.nextBestOutRaw ?? null
  const nextBestSource = params.nextBestSource ?? null

  return {
    executionNumber: params.executionNumber,
    txHash: params.txHash,
    txUrl: explorerTxUrl(params.txHash, params.chainId),
    timestamp,
    amountInRaw: decoded.amountIn.toString(),
    amountOutRaw: decoded.amountOut.toString(),
    effectivePrice: computeEffectivePrice(decoded.amountIn, decoded.amountOut, params.tokenInDecimals, params.tokenOutDecimals),
    protocolFeeRaw: decoded.fee.toString(),
    networkCostWeiRaw: networkCostWei.toString(),
    nextBestOutRaw,
    nextBestSource,
    aggregationValueRaw: computeAggregationValueRaw(decoded.amountOut.toString(), nextBestOutRaw),
  }
}

const receiptCache = new Map<string, SettlementReceipt>()

/** Test-only: reset the in-memory receipt cache between cases. */
export function _clearSettlementReceiptCache(): void {
  receiptCache.clear()
}

export interface BuildSettlementReceiptParams {
  orderHash: string
  status: SettlementStatus
  chainId: number
  tokenInSymbol: string
  tokenOutSymbol: string
  tokenInDecimals: number
  tokenOutDecimals: number
  maxSlippageBps?: number | null
  fills: readonly FillSource[]
  /** Test seam — defaults to the real per-chain viem client. */
  getClient?: (chainId: number) => ReceiptClient
  /** Test seam — defaults to the real per-chain v2/v3 OrderExecutor addresses. */
  executorAddresses?: readonly string[]
}

/**
 * Assemble the full settlement receipt for a completed/cancelled DCA position. Cached per
 * `chainId:orderHash` — a terminal position's data never changes, so a repeat call is a no-op.
 */
export async function buildSettlementReceipt(params: BuildSettlementReceiptParams): Promise<SettlementReceipt> {
  const cacheKey = `${params.chainId}:${params.orderHash}`
  const cached = receiptCache.get(cacheKey)
  if (cached) return cached

  const getClient = params.getClient ?? ((chainId: number) => asReceiptClient(getPublicClientForChain(chainId)))
  const client = getClient(params.chainId)

  const executorAddresses =
    params.executorAddresses ??
    [getOrderExecutor(params.chainId), getOrderExecutorV3(params.chainId)].filter((a): a is Address => a != null)

  const withTx = params.fills.filter((f): f is FillSource & { txHash: string } => !!f.txHash)
  const settled = await Promise.all(
    withTx.map((f) =>
      fetchFillReceipt(client, {
        chainId: params.chainId,
        txHash: f.txHash,
        executionNumber: f.executionNumber,
        tokenInDecimals: params.tokenInDecimals,
        tokenOutDecimals: params.tokenOutDecimals,
        executorAddresses,
        fallbackTimestampMs: f.createdAt ? Date.parse(f.createdAt) : null,
        nextBestOutRaw: f.nextBestOutRaw ?? null,
        nextBestSource: f.nextBestSource ?? null,
      }),
    ),
  )
  const fills = settled
    .filter((f): f is FillReceipt => f != null)
    .sort((a, b) => a.executionNumber - b.executionNumber)

  const totals = computeSettlementTotals(fills, params)
  const estimate = computeEstimateComparison(totals, { maxSlippageBps: params.maxSlippageBps })

  const receipt: SettlementReceipt = {
    orderHash: params.orderHash,
    status: params.status,
    chainId: params.chainId,
    tokenInSymbol: params.tokenInSymbol,
    tokenOutSymbol: params.tokenOutSymbol,
    tokenInDecimals: params.tokenInDecimals,
    tokenOutDecimals: params.tokenOutDecimals,
    fills,
    totals,
    estimate,
    networkCostLabel: NETWORK_COST_LABEL,
  }
  receiptCache.set(cacheKey, receipt)
  return receipt
}
