/**
 * [ADR-029 section 7, details H of goal 133b] One function decides whether a transaction is a wallet's swap:
 * `verifySwapOnChain({ chainId, txHash, wallet })`. The caller no longer names a source: the chain says what it was.
 *
 * Server-only. It reads the transaction and its receipt on ONE chain (chain-read.ts) and answers:
 *
 *   rejected   the input is not ours to check (unknown chain, malformed hash or wallet: NO chain read), or the
 *              transaction is not this wallet's swap
 *   not_found  the transaction or its receipt is not there (yet), or the chain could not be read, or the answer had a
 *              shape this function does not know. Nothing is confirmed on doubt.
 *   confirmed  receipt status success, and one of the three proofs below holds
 *   failed     receipt status reverted, sent BY the wallet TO our FeeCollector or to a listed router (H.4)
 *
 * The proof is an event or a net flow, never the target alone (ADR-029 7.1). Tried in this order (H.4):
 *   fee_collector  EXACTLY ONE SwapWithFee log EMITTED BY that chain's FeeCollector (mainnet: also the frozen V1) whose
 *                  `user` is the wallet. tx.to and tx.from are not checked, so a smart-contract wallet (a bundler sending
 *                  to the EntryPoint) verifies. More than one for the wallet: rejected `ambiguous`. None, and tx.to is
 *                  the FeeCollector: rejected `no_swap_event` (a getter call, an admin call).
 *   cow            a Trade log EMITTED BY that chain's settlement contract whose owner is the wallet; tx.to is not
 *                  checked (about half of real settlements are sent to a solver's own contract). More than one Trade
 *                  of the wallet: the one the wallet's pending row agrees with (same sell token, same buy asset), else
 *                  rejected `ambiguous`.
 *   router         tx.from is the wallet, tx.to is a router of ANY source on that chain (ROUTER_WHITELIST_BY_CHAIN), and
 *                  after NETTING every token's Transfer legs for the wallet (in minus out) there is exactly one in
 *                  side: the one token with a net outflow, or the transaction value when no token has a net outflow;
 *                  and at most one out side: the one DIFFERENT token with a net inflow. No in side, two candidates on
 *                  a side, or the same token on both: rejected `no_net_swap`. A token that nets to zero is no side, so
 *                  a transaction that moves tokens out and back (A103 S-1) proves nothing. ETH as the only in side
 *                  needs a token that arrives (owner, 2026-11-26): ETH coming back leaves no log, so "1 ETH sent and
 *                  refunded" would otherwise be a 1 ETH sale.
 *
 * derived: nothing here is ever taken from the caller.
 *   fee_collector  the event: tokenIn, totalAmount, tokenOut, outputAmount (address(0) is native ETH). The frozen V1's
 *                  event has no output: its out side is the netted inflow (one different token, else null).
 *   cow            the Trade: sellToken/sellAmount, buyToken/buyAmount
 *   router         the netted sides above
 *   failed         both sides null (a reverted transaction moved nothing). `callTokenIn` says which token the CALL
 *                  named (the ETH value, or the FeeCollector call's token argument), only so the caller can find the
 *                  pending row it belongs to; it is never written as a side.
 *   source         cow: 'cowswap'. router: the source that lists tx.to on that chain. fee_collector: the source that
 *                  lists the router the event (or, reverted, the call) names. When two sources list one router: the
 *                  pending row's source if it is one of them, else the first in ROUTER_WHITELIST_BY_CHAIN's own order
 *                  for that chain. 'unknown' when no source lists it.
 *
 * `pending` (the wallet's pending rows on that chain, newest first) is never proof. It only breaks the two ties the
 * chain leaves open: two sources listing one router, and two CoW trades of one wallet in one settlement.
 */
import { decodeEventLog, decodeFunctionData, parseAbi } from 'viem'
import { AGGREGATOR_APIS, COW_SETTLEMENT, FEE_COLLECTOR_ABI, NATIVE_ETH, hasCowApi } from '@/lib/constants'
import { CHAIN_CONFIGS, getWrappedNative } from '@/lib/chains/registry'
import { ROUTER_WHITELIST_BY_CHAIN } from '@/lib/chains/routers'
import { ChainReadError, readChain, type ChainRead } from './chain-read'

export type VerifyOutcome = 'confirmed' | 'failed' | 'not_found' | 'rejected'
export type VerifiedKind = 'fee_collector' | 'router' | 'cow'

/** Why a transaction was not confirmed. Fixed words only: safe in a log line and in a report. */
export type VerifyReason =
  | 'bad_chain'
  | 'bad_tx_hash'
  | 'bad_wallet'
  | 'tx_missing'
  | 'receipt_missing'
  | 'rpc_error'
  | 'rpc_wrong_chain'
  | 'rpc_unverified'
  | 'rpc_malformed'
  | 'wrong_sender'
  | 'wrong_target'
  | 'cow_no_trade_for_wallet'
  | 'no_swap_event'
  | 'no_net_swap'
  | 'ambiguous'

export interface DerivedSwap {
  /** Lowercase token address; native ETH is the app's placeholder (NATIVE_ETH, lowercase). null: not derivable. */
  tokenIn: string | null
  /** Raw units, decimal digits. null: not derivable. */
  amountIn: string | null
  tokenOut: string | null
  amountOut: string | null
  /** A source name of the app, or 'unknown'. Decided by the chain, never by the caller. */
  source: string
  /** From the receipt, decimal digits. */
  gasUsed: string | null
  gasPrice: string | null
}

/** What one of the wallet's pending rows says. A hint, never proof. */
export interface PendingHint {
  source?: string | null
  tokenIn?: string | null
  tokenOut?: string | null
}

export interface VerifySwapInput {
  chainId: number
  txHash: string
  wallet: string
  /** The wallet's pending rows on this chain, newest first: tie-breaks only (see the header). */
  pending?: readonly PendingHint[]
}

export interface VerifySwapResult {
  outcome: VerifyOutcome
  kind?: VerifiedKind
  reason?: VerifyReason
  derived?: DerivedSwap
  /** failed only: the token the reverted CALL named (never a side of the row). null: the call does not say. */
  callTokenIn?: string | null
}

export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const QUANTITY_RE = /^0x[0-9a-fA-F]+$/
const HEX_DATA_RE = /^0x([0-9a-fA-F]{2})*$/
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/

/** The app's native placeholder, as a row stores it. */
export const NATIVE_PLACEHOLDER = NATIVE_ETH.toLowerCase()
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** The source of a swap whose router no source of the app lists on that chain. */
export const UNKNOWN_SOURCE = 'unknown'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const FEE_COLLECTOR_EVENTS = parseAbi([
  'event SwapWithFee(address indexed user, address indexed router, address tokenIn, uint256 totalAmount, uint256 feeAmount, address tokenOut, uint256 outputAmount)',
])
/** The frozen mainnet V1 (contracts/TeraSwapFeeCollector_flat.sol:116): no tokenOut, no outputAmount. */
const FEE_COLLECTOR_V1_EVENTS = parseAbi([
  'event SwapWithFee(address indexed user, address indexed router, address tokenIn, uint256 totalAmount, uint256 feeAmount)',
])
const COW_EVENTS = parseAbi([
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
])

/** The chains of the app (chains/registry.ts). */
export function isSwapLogChain(chainId: unknown): chainId is number {
  return typeof chainId === 'number' && Number.isInteger(chainId) && Object.prototype.hasOwnProperty.call(CHAIN_CONFIGS, chainId)
}

/** A name of the app's AggregatorName list (constants.ts). */
export function isSwapLogSource(source: unknown): source is string {
  return typeof source === 'string' && Object.prototype.hasOwnProperty.call(AGGREGATOR_APIS, source)
}

/** That chain's FeeCollector contracts, lowercase. Empty when the chain has none configured. */
export function feeCollectorsOf(chainId: number): { current: string | null; v1: string | null } {
  const contracts = isSwapLogChain(chainId) ? CHAIN_CONFIGS[chainId].contracts : null
  return {
    current: contracts?.feeCollector ? contracts.feeCollector.toLowerCase() : null,
    v1: contracts?.feeCollectorV1 ? contracts.feeCollectorV1.toLowerCase() : null,
  }
}

/** That chain's CoW settlement contract, lowercase; null where CoW has no deployment the app uses. */
export function cowSettlementOf(chainId: number): string | null {
  return isSwapLogChain(chainId) && hasCowApi(chainId) ? COW_SETTLEMENT.toLowerCase() : null
}

function routersOn(chainId: number): Record<string, `0x${string}`> | null {
  return Object.prototype.hasOwnProperty.call(ROUTER_WHITELIST_BY_CHAIN, chainId) ? ROUTER_WHITELIST_BY_CHAIN[chainId] : null
}

/** The router of `source` on `chainId`, lowercase; null when the whitelist has none. */
export function routerOf(chainId: number, source: string): string | null {
  const byChain = routersOn(chainId)
  if (!byChain || !Object.prototype.hasOwnProperty.call(byChain, source)) return null
  return byChain[source].toLowerCase()
}

/** The sources that list `router` on `chainId`, in ROUTER_WHITELIST_BY_CHAIN's own order for that chain. */
export function sourcesOfRouter(chainId: number, router: string): string[] {
  const byChain = routersOn(chainId)
  if (!byChain) return []
  const lower = router.toLowerCase()
  return Object.keys(byChain).filter((name) => byChain[name].toLowerCase() === lower)
}

/**
 * The source whose router is `router` on `chainId`: the first of `preferred` (the pending rows' sources, newest first)
 * that lists it, else the first in the whitelist's order for that chain, else 'unknown'.
 */
export function sourceOfRouter(chainId: number, router: string, preferred?: string | readonly (string | null | undefined)[]): string {
  const names = sourcesOfRouter(chainId, router)
  const wanted = typeof preferred === 'string' ? [preferred] : (preferred ?? [])
  for (const p of wanted) if (typeof p === 'string' && names.includes(p)) return p
  return names[0] ?? UNKNOWN_SOURCE
}

interface ChainLog {
  address: string
  topics: `0x${string}`[]
  data: `0x${string}`
}

interface ChainTx {
  hash: string
  from: string
  to: string | null
  value: bigint
  input: `0x${string}`
}

interface ChainReceipt {
  transactionHash: string
  from: string | null
  to: string | null
  status: 'success' | 'reverted'
  logs: ChainLog[]
  gasUsed: string | null
  gasPrice: string | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function lowerAddress(v: unknown): string | null {
  return typeof v === 'string' && ADDRESS_RE.test(v) ? v.toLowerCase() : null
}

function quantity(v: unknown): bigint | null {
  return typeof v === 'string' && QUANTITY_RE.test(v) ? BigInt(v) : null
}

/** `null`: a shape this function does not know. */
function parseTx(raw: unknown): ChainTx | null {
  if (!isRecord(raw)) return null
  const hash = typeof raw.hash === 'string' && TX_HASH_RE.test(raw.hash) ? raw.hash.toLowerCase() : null
  const from = lowerAddress(raw.from)
  const to = raw.to === null ? null : lowerAddress(raw.to)
  const value = quantity(raw.value)
  const input = typeof raw.input === 'string' && HEX_DATA_RE.test(raw.input) ? (raw.input as `0x${string}`) : null
  if (hash === null || from === null || value === null || input === null) return null
  if (raw.to !== null && to === null) return null
  return { hash, from, to, value, input }
}

function parseLog(raw: unknown): ChainLog | null {
  if (!isRecord(raw)) return null
  const address = lowerAddress(raw.address)
  if (address === null || !Array.isArray(raw.topics)) return null
  const topics: `0x${string}`[] = []
  for (const t of raw.topics) {
    if (typeof t !== 'string' || !TOPIC_RE.test(t)) return null
    topics.push(t.toLowerCase() as `0x${string}`)
  }
  if (typeof raw.data !== 'string' || !HEX_DATA_RE.test(raw.data)) return null
  return { address, topics, data: raw.data as `0x${string}` }
}

function parseReceipt(raw: unknown): ChainReceipt | null {
  if (!isRecord(raw)) return null
  const transactionHash =
    typeof raw.transactionHash === 'string' && TX_HASH_RE.test(raw.transactionHash) ? raw.transactionHash.toLowerCase() : null
  if (transactionHash === null) return null
  const status = raw.status === '0x1' ? 'success' : raw.status === '0x0' ? 'reverted' : null
  if (status === null || !Array.isArray(raw.logs)) return null
  const logs: ChainLog[] = []
  for (const l of raw.logs) {
    const log = parseLog(l)
    if (log === null) return null
    logs.push(log)
  }
  const gasUsed = quantity(raw.gasUsed)
  const gasPrice = quantity(raw.effectiveGasPrice)
  return {
    transactionHash,
    from: raw.from === undefined || raw.from === null ? null : lowerAddress(raw.from),
    to: raw.to === undefined || raw.to === null ? null : lowerAddress(raw.to),
    status,
    logs,
    gasUsed: gasUsed === null ? null : gasUsed.toString(),
    gasPrice: gasPrice === null ? null : gasPrice.toString(),
  }
}

/** address(0) (FeeCollector) means native ETH; CoW's buy-ETH marker already is the app's placeholder. */
function tokenOrNative(address: string): string {
  const lower = address.toLowerCase()
  return lower === ZERO_ADDRESS ? NATIVE_PLACEHOLDER : lower
}

/** Same asset for matching a pending row: equal, or native ETH and that chain's wrapped native. */
function sameAsset(chainId: number, a: string, b: string): boolean {
  if (a === b) return true
  const wrapped = getWrappedNative(chainId).toLowerCase()
  return (a === NATIVE_PLACEHOLDER && b === wrapped) || (a === wrapped && b === NATIVE_PLACEHOLDER)
}

type Side = { token: string; amount: string } | null

const NO_SIDES: { in: Side; out: Side } = { in: null, out: null }

/** The wallet's ERC-20 Transfer legs, NETTED per token: inflow minus outflow. Zero nets are dropped. */
export function netTokenFlows(logs: readonly ChainLog[], wallet: string): Map<string, bigint> {
  const net = new Map<string, bigint>()
  for (const log of logs) {
    // ERC-20 Transfer(address indexed from, address indexed to, uint256 value): three topics, one word of data.
    // (An ERC-721 Transfer has four topics and no data: not a token amount, not a leg.)
    if (log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC || log.data.length !== 66) continue
    const from = `0x${log.topics[1].slice(26)}`
    const to = `0x${log.topics[2].slice(26)}`
    const value = BigInt(log.data)
    if (value === 0n || from === to) continue
    if (from === wallet) net.set(log.address, (net.get(log.address) ?? 0n) - value)
    if (to === wallet) net.set(log.address, (net.get(log.address) ?? 0n) + value)
  }
  for (const [token, amount] of net) if (amount === 0n) net.delete(token)
  return net
}

/** The one token with a net inflow, different from `notToken`; null when there is none or more than one. */
function singleNetInflow(net: Map<string, bigint>, notToken: string | null): Side | 'two' {
  const inflows = [...net].filter(([token, amount]) => amount > 0n && token !== notToken)
  if (inflows.length > 1) return 'two'
  return inflows.length === 1 ? { token: inflows[0][0], amount: inflows[0][1].toString() } : null
}

/** H.3: the router kind's sides after netting, or null (`no_net_swap`). */
function routerSides(tx: ChainTx, logs: readonly ChainLog[], wallet: string): { in: Side; out: Side } | null {
  const net = netTokenFlows(logs, wallet)
  const outflows = [...net].filter(([, amount]) => amount < 0n)
  const inflows = [...net].filter(([, amount]) => amount > 0n)
  if (outflows.length > 1 || inflows.length > 1) return null

  let sideIn: { token: string; amount: string }
  if (outflows.length === 1) sideIn = { token: outflows[0][0], amount: (-outflows[0][1]).toString() }
  else if (tx.value > 0n) sideIn = { token: NATIVE_PLACEHOLDER, amount: tx.value.toString() }
  else return null

  const sideOut: Side = inflows.length === 1 ? { token: inflows[0][0], amount: inflows[0][1].toString() } : null
  if (sideOut !== null && sideOut.token === sideIn.token) return null
  // Owner, 2026-11-26: ETH as the only in side needs a token that arrives (ETH coming back leaves no log).
  if (sideIn.token === NATIVE_PLACEHOLDER && sideOut === null) return null
  return { in: sideIn, out: sideOut }
}

interface FeeCollectorEvent {
  router: string
  tokenIn: string
  totalAmount: bigint
  tokenOut: string | null
  outputAmount: bigint | null
}

/** The SwapWithFee events one of `collectors` EMITTED for `wallet` in this receipt (current ABI first, then the V1's). */
function feeCollectorEvents(logs: readonly ChainLog[], collectors: readonly string[], wallet: string): FeeCollectorEvent[] {
  const found: FeeCollectorEvent[] = []
  for (const log of logs) {
    if (!collectors.includes(log.address)) continue
    const topics = log.topics as [`0x${string}`, ...`0x${string}`[]]
    try {
      const { args } = decodeEventLog({ abi: FEE_COLLECTOR_EVENTS, data: log.data, topics })
      if (args.user.toLowerCase() !== wallet) continue
      found.push({
        router: args.router.toLowerCase(),
        tokenIn: tokenOrNative(args.tokenIn),
        totalAmount: args.totalAmount,
        tokenOut: tokenOrNative(args.tokenOut),
        outputAmount: args.outputAmount,
      })
      continue
    } catch {
      // Not the current event: try the V1 shape.
    }
    try {
      const { args } = decodeEventLog({ abi: FEE_COLLECTOR_V1_EVENTS, data: log.data, topics })
      if (args.user.toLowerCase() !== wallet) continue
      found.push({ router: args.router.toLowerCase(), tokenIn: tokenOrNative(args.tokenIn), totalAmount: args.totalAmount, tokenOut: null, outputAmount: null })
    } catch {
      // Another event of the FeeCollector (Paused, RouterWhitelisted, ...): not a swap.
    }
  }
  return found
}

/** What a FeeCollector CALL names (a reverted transaction has no event): its router and its input token. */
function feeCollectorCall(input: `0x${string}`): { router: string; tokenIn: string } | null {
  try {
    const call = decodeFunctionData({ abi: FEE_COLLECTOR_ABI, data: input })
    if (call.functionName === 'swapETHWithFee') return { router: call.args[0].toLowerCase(), tokenIn: NATIVE_PLACEHOLDER }
    if (call.functionName === 'swapTokenWithFee') return { router: call.args[2].toLowerCase(), tokenIn: tokenOrNative(call.args[0]) }
    return null
  } catch {
    return null
  }
}

interface CowTrade {
  sellToken: string
  buyToken: string
  sellAmount: bigint
  buyAmount: bigint
}

/** The Trade events the settlement contract emitted for `wallet` in this receipt. */
function cowTradesOf(logs: readonly ChainLog[], settlement: string, wallet: string): CowTrade[] {
  const trades: CowTrade[] = []
  for (const log of logs) {
    if (log.address !== settlement) continue
    try {
      const { args } = decodeEventLog({ abi: COW_EVENTS, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
      if (args.owner.toLowerCase() !== wallet) continue
      trades.push({
        sellToken: tokenOrNative(args.sellToken),
        buyToken: tokenOrNative(args.buyToken),
        sellAmount: args.sellAmount,
        buyAmount: args.buyAmount,
      })
    } catch {
      // Another event of the settlement contract (Settlement, Interaction, ...): not a trade.
    }
  }
  return trades
}

/** H.2: one trade, or the one trade the newest agreeing pending row names; null = ambiguous. */
function chooseTrade(chainId: number, trades: readonly CowTrade[], hints: readonly PendingHint[]): CowTrade | null {
  if (trades.length === 1) return trades[0]
  for (const hint of hints) {
    if (typeof hint.tokenIn !== 'string') continue
    const tokenIn = hint.tokenIn
    const tokenOut = typeof hint.tokenOut === 'string' ? hint.tokenOut : null
    const agreeing = trades.filter((t) => t.sellToken === tokenIn && (tokenOut === null || sameAsset(chainId, tokenOut, t.buyToken)))
    if (agreeing.length === 1) return agreeing[0]
    if (agreeing.length > 1) return null
  }
  return null
}

/** Only well-formed hints are looked at: a source of the app's list, lowercase addresses. */
function cleanHints(pending: unknown): PendingHint[] {
  if (!Array.isArray(pending)) return []
  const out: PendingHint[] = []
  for (const p of pending) {
    if (!isRecord(p)) continue
    out.push({
      source: isSwapLogSource(p.source) ? p.source : null,
      tokenIn: lowerAddress(p.tokenIn),
      tokenOut: lowerAddress(p.tokenOut),
    })
  }
  return out
}

function rejected(reason: VerifyReason): VerifySwapResult {
  return { outcome: 'rejected', reason }
}

function notFound(reason: VerifyReason): VerifySwapResult {
  return { outcome: 'not_found', reason }
}

function derivedOf(sides: { in: Side; out: Side }, source: string, gas: { gasUsed: string | null; gasPrice: string | null }): DerivedSwap {
  return {
    tokenIn: sides.in?.token ?? null,
    amountIn: sides.in?.amount ?? null,
    tokenOut: sides.out?.token ?? null,
    amountOut: sides.out?.amount ?? null,
    source,
    ...gas,
  }
}

export interface VerifyDeps {
  /** The chain read. Tests pass a recorded one; production uses chain-read.ts. */
  read?: ChainRead
}

/**
 * Details H. Two chain reads on that chain whenever the transaction exists (the transaction, then its receipt: an event
 * can prove a swap whoever sent it, so only the receipt can say no); one when it does not; none when the input is
 * rejected. Each read is one attempt and one retry at most (chain-read.ts).
 */
export async function verifySwapOnChain(input: VerifySwapInput, deps: VerifyDeps = {}): Promise<VerifySwapResult> {
  // Anything that is not one of ours is rejected before any chain read.
  if (!isSwapLogChain(input.chainId)) return rejected('bad_chain')
  if (typeof input.txHash !== 'string' || !TX_HASH_RE.test(input.txHash)) return rejected('bad_tx_hash')
  if (typeof input.wallet !== 'string' || !ADDRESS_RE.test(input.wallet)) return rejected('bad_wallet')

  const chainId = input.chainId
  const txHash = input.txHash.toLowerCase()
  const wallet = input.wallet.toLowerCase()
  const hints = cleanHints(input.pending)
  const hintSources = hints.map((h) => h.source)
  const read = deps.read ?? readChain

  // The transaction.
  let rawTx: unknown
  try {
    rawTx = await read(chainId, 'eth_getTransactionByHash', [txHash])
  } catch (err) {
    return notFound(err instanceof ChainReadError ? err.code : 'rpc_error')
  }
  if (rawTx === null || rawTx === undefined) return notFound('tx_missing')
  const tx = parseTx(rawTx)
  if (tx === null || tx.hash !== txHash) return notFound('rpc_malformed')

  // The receipt.
  let rawReceipt: unknown
  try {
    rawReceipt = await read(chainId, 'eth_getTransactionReceipt', [txHash])
  } catch (err) {
    return notFound(err instanceof ChainReadError ? err.code : 'rpc_error')
  }
  if (rawReceipt === null || rawReceipt === undefined) return notFound('receipt_missing')
  const receipt = parseReceipt(rawReceipt)
  if (receipt === null || receipt.transactionHash !== txHash) return notFound('rpc_malformed')
  // The two answers must describe the same transaction.
  if (receipt.from !== null && receipt.from !== tx.from) return notFound('rpc_malformed')
  if (receipt.to !== null && receipt.to !== tx.to) return notFound('rpc_malformed')
  // A reverted transaction emits nothing. A receipt that says "reverted" and still carries logs is not a shape of the chain.
  if (receipt.status === 'reverted' && receipt.logs.length > 0) return notFound('rpc_malformed')

  const gas = { gasUsed: receipt.gasUsed, gasPrice: receipt.gasPrice }
  const collectors = feeCollectorsOf(chainId)
  const collectorList = [collectors.current, collectors.v1].filter((c): c is string => c !== null)
  const settlement = cowSettlementOf(chainId)
  const toCollector = tx.to !== null && collectorList.includes(tx.to)
  const toRouter = tx.to !== null && sourcesOfRouter(chainId, tx.to).length > 0

  // H.4: a reverted transaction is `failed` only when the wallet sent it to our FeeCollector or to a listed router.
  if (receipt.status === 'reverted') {
    if (!toCollector && !toRouter) return rejected(tx.to !== null && tx.to === settlement ? 'cow_no_trade_for_wallet' : 'wrong_target')
    if (tx.from !== wallet) return rejected('wrong_sender')
    if (toCollector) {
      const named = feeCollectorCall(tx.input)
      return {
        outcome: 'failed',
        kind: 'fee_collector',
        derived: derivedOf(NO_SIDES, named === null ? UNKNOWN_SOURCE : sourceOfRouter(chainId, named.router, hintSources), gas),
        callTokenIn: named?.tokenIn ?? (tx.value > 0n ? NATIVE_PLACEHOLDER : null),
      }
    }
    return {
      outcome: 'failed',
      kind: 'router',
      derived: derivedOf(NO_SIDES, sourceOfRouter(chainId, tx.to as string, hintSources), gas),
      callTokenIn: tx.value > 0n ? NATIVE_PLACEHOLDER : null,
    }
  }

  // 1. fee_collector: the FeeCollector's own event for this wallet, whoever sent the transaction.
  const events = feeCollectorEvents(receipt.logs, collectorList, wallet)
  if (events.length > 1) return rejected('ambiguous')
  if (events.length === 1) {
    const event = events[0]
    let out: Side
    if (event.tokenOut !== null && event.outputAmount !== null) out = { token: event.tokenOut, amount: event.outputAmount.toString() }
    else {
      // The frozen V1: no output in its event; the one different token that came in, else null.
      const inflow = singleNetInflow(netTokenFlows(receipt.logs, wallet), event.tokenIn)
      out = inflow === 'two' ? null : inflow
    }
    const sides = { in: { token: event.tokenIn, amount: event.totalAmount.toString() }, out }
    return { outcome: 'confirmed', kind: 'fee_collector', derived: derivedOf(sides, sourceOfRouter(chainId, event.router, hintSources), gas) }
  }
  if (toCollector) return rejected('no_swap_event')

  // 2. cow: the settlement contract's Trade event for this wallet, whoever sent the transaction and to whom.
  const trades = settlement !== null ? cowTradesOf(receipt.logs, settlement, wallet) : []
  if (trades.length > 0) {
    const trade = chooseTrade(chainId, trades, hints)
    if (trade === null) return rejected('ambiguous')
    const sides = { in: { token: trade.sellToken, amount: trade.sellAmount.toString() }, out: { token: trade.buyToken, amount: trade.buyAmount.toString() } }
    return { outcome: 'confirmed', kind: 'cow', derived: derivedOf(sides, 'cowswap', gas) }
  }

  // 3. router: sent by the wallet to a listed router, and a net swap of the wallet's own tokens.
  if (!toRouter) return rejected(tx.to !== null && tx.to === settlement ? 'cow_no_trade_for_wallet' : 'wrong_target')
  if (tx.from !== wallet) return rejected('wrong_sender')
  const sides = routerSides(tx, receipt.logs, wallet)
  if (sides === null) return rejected('no_net_swap')
  return { outcome: 'confirmed', kind: 'router', derived: derivedOf(sides, sourceOfRouter(chainId, tx.to as string, hintSources), gas) }
}
