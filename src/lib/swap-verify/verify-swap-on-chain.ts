/**
 * [ADR-029, details A] One function decides whether a swap row is real: `verifySwapOnChain`.
 *
 * Server-only. It reads the transaction and its receipt on the ROW's chain (chain-read.ts) and answers:
 *
 *   rejected   the input is not ours to check (unknown chain, malformed hash or wallet, unknown source: NO chain
 *              read), or the transaction is not this wallet's swap (wrong sender, wrong target, no CoW trade of the wallet)
 *   not_found  the transaction or its receipt is not there (yet), or the chain could not be read, or the answer had a
 *              shape this function does not know. Nothing is confirmed on doubt: the caller leaves the row as it is.
 *   confirmed  receipt status success
 *   failed     receipt status reverted
 *
 * kind (A.4), all three decided by the chain the row is on:
 *   fee_collector  tx.to is that chain's FeeCollector (chains/registry.ts; mainnet also the frozen V1), tx.from is the wallet
 *   router         tx.to is ROUTER_WHITELIST_BY_CHAIN[chain][source], tx.from is the wallet
 *   cow            the source is cowswap and the receipt has a Trade event EMITTED BY that chain's CoW settlement contract
 *                  whose owner is the wallet. The solver sends the transaction, so tx.from says nothing; and tx.to says
 *                  nothing either (owner's answer of 2026-11-25, which replaces "tx.to equals the settlement contract"):
 *                  measured that day, 39 of 84 recent settlements on the three chains were sent to a solver's own
 *                  contract, which then calls the settlement contract. No other contract can emit a log under the
 *                  settlement contract's address, so the event is the proof.
 *
 * derived (A.6 and the owner's answer of 2026-11-25): nothing here is ever taken from the caller.
 *   fee_collector  the FeeCollector's own SwapWithFee event for that wallet: tokenIn, totalAmount, tokenOut, outputAmount
 *                  (address(0) is native ETH). The frozen V1 emits no output: its sides follow the router rule.
 *   router         in  = the wallet's outgoing ERC-20 Transfer legs, or tx.value
 *                  out = the wallet's incoming ERC-20 Transfer legs
 *   cow            the Trade event: sellToken/sellAmount, buyToken/buyAmount
 *   More than one candidate token on a side, or a native leg that leaves no log: that side is null.
 *   A reverted transaction moved nothing: both sides are null.
 *   source         cow: 'cowswap'. router: the source whose router tx.to is (the input, now proved). fee_collector: the
 *                  source whose router the FeeCollector call names; 'unknown' when no source has that router.
 */
import { decodeEventLog, decodeFunctionData, parseAbi } from 'viem'
import { AGGREGATOR_APIS, COW_SETTLEMENT, FEE_COLLECTOR_ABI, NATIVE_ETH, hasCowApi } from '@/lib/constants'
import { CHAIN_CONFIGS } from '@/lib/chains/registry'
import { ROUTER_WHITELIST_BY_CHAIN } from '@/lib/chains/routers'
import { ChainReadError, readChain, type ChainRead } from './chain-read'

export type VerifyOutcome = 'confirmed' | 'failed' | 'not_found' | 'rejected'
export type VerifiedKind = 'fee_collector' | 'router' | 'cow'

/** Why a row was not confirmed. Fixed words only: safe in a log line and in a report. */
export type VerifyReason =
  | 'bad_chain'
  | 'bad_tx_hash'
  | 'bad_wallet'
  | 'bad_source'
  | 'tx_missing'
  | 'receipt_missing'
  | 'rpc_error'
  | 'rpc_wrong_chain'
  | 'rpc_unverified'
  | 'rpc_malformed'
  | 'wrong_sender'
  | 'wrong_target'
  | 'cow_no_trade_for_wallet'

export interface DerivedSwap {
  /** Lowercase token address; native ETH is the app's placeholder (NATIVE_ETH, lowercase). null: not derivable. */
  tokenIn: string | null
  /** Raw units, decimal digits. null: not derivable. */
  amountIn: string | null
  tokenOut: string | null
  amountOut: string | null
  /** A source name of the app, or 'unknown'. Never the caller's text unless the chain proved it. */
  source: string
  /** From the receipt, decimal digits. */
  gasUsed: string | null
  gasPrice: string | null
}

export interface VerifySwapInput {
  chainId: number
  txHash: string
  wallet: string
  source: string
}

export interface VerifySwapResult {
  outcome: VerifyOutcome
  kind?: VerifiedKind
  reason?: VerifyReason
  derived?: DerivedSwap
}

export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const QUANTITY_RE = /^0x[0-9a-fA-F]+$/
const HEX_DATA_RE = /^0x([0-9a-fA-F]{2})*$/
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/

/** The app's native placeholder, as a row stores it. */
export const NATIVE_PLACEHOLDER = NATIVE_ETH.toLowerCase()
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** The source of a FeeCollector swap whose router no source of the app has on that chain. */
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

/** The router of `source` on `chainId`, lowercase; null when the whitelist has none. */
export function routerOf(chainId: number, source: string): string | null {
  const byChain = Object.prototype.hasOwnProperty.call(ROUTER_WHITELIST_BY_CHAIN, chainId) ? ROUTER_WHITELIST_BY_CHAIN[chainId] : null
  if (!byChain || !Object.prototype.hasOwnProperty.call(byChain, source)) return null
  return byChain[source].toLowerCase()
}

/** The source whose router is `router` on `chainId`: `preferred` when it is one of them, else the first, else 'unknown'. */
export function sourceOfRouter(chainId: number, router: string, preferred?: string): string {
  const byChain = Object.prototype.hasOwnProperty.call(ROUTER_WHITELIST_BY_CHAIN, chainId) ? ROUTER_WHITELIST_BY_CHAIN[chainId] : null
  if (!byChain) return UNKNOWN_SOURCE
  const lower = router.toLowerCase()
  const names = Object.keys(byChain).filter((name) => byChain[name].toLowerCase() === lower)
  if (preferred !== undefined && names.includes(preferred)) return preferred
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

type Side = { token: string; amount: string } | null

const NO_SIDES: { in: Side; out: Side } = { in: null, out: null }

/** A.6, kind router (and the frozen V1): the wallet's ERC-20 Transfer legs and tx.value. One candidate per side or null. */
function sidesFromTransferLegs(tx: ChainTx, logs: readonly ChainLog[], wallet: string): { in: Side; out: Side } {
  const outgoing = new Map<string, bigint>()
  const incoming = new Map<string, bigint>()
  for (const log of logs) {
    // ERC-20 Transfer(address indexed from, address indexed to, uint256 value): three topics, one word of data.
    // (An ERC-721 Transfer has four topics and no data: not a token amount, not a leg.)
    if (log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC || log.data.length !== 66) continue
    const from = `0x${log.topics[1].slice(26)}`
    const to = `0x${log.topics[2].slice(26)}`
    if (from === to) continue
    const value = BigInt(log.data)
    if (value === 0n) continue
    if (from === wallet) outgoing.set(log.address, (outgoing.get(log.address) ?? 0n) + value)
    if (to === wallet) incoming.set(log.address, (incoming.get(log.address) ?? 0n) + value)
  }

  const inCandidates: { token: string; amount: string }[] = [...outgoing].map(([token, amount]) => ({ token, amount: amount.toString() }))
  if (tx.value > 0n) inCandidates.push({ token: NATIVE_PLACEHOLDER, amount: tx.value.toString() })
  const outCandidates: { token: string; amount: string }[] = [...incoming].map(([token, amount]) => ({ token, amount: amount.toString() }))

  return {
    in: inCandidates.length === 1 ? inCandidates[0] : null,
    out: outCandidates.length === 1 ? outCandidates[0] : null,
  }
}

interface FeeCollectorEvent {
  router: string
  tokenIn: string
  totalAmount: bigint
  tokenOut: string | null
  outputAmount: bigint | null
}

/** The SwapWithFee events `collector` emitted for `wallet` in this receipt (current ABI first, then the frozen V1's). */
function feeCollectorEvents(logs: readonly ChainLog[], collector: string, wallet: string): FeeCollectorEvent[] {
  const found: FeeCollectorEvent[] = []
  for (const log of logs) {
    if (log.address !== collector) continue
    try {
      const { args } = decodeEventLog({ abi: FEE_COLLECTOR_EVENTS, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
      if (args.user.toLowerCase() !== wallet) continue
      found.push({
        router: args.router.toLowerCase(),
        tokenIn: args.tokenIn.toLowerCase(),
        totalAmount: args.totalAmount,
        tokenOut: args.tokenOut.toLowerCase(),
        outputAmount: args.outputAmount,
      })
      continue
    } catch {
      // Not the current event: try the V1 shape.
    }
    try {
      const { args } = decodeEventLog({ abi: FEE_COLLECTOR_V1_EVENTS, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
      if (args.user.toLowerCase() !== wallet) continue
      found.push({ router: args.router.toLowerCase(), tokenIn: args.tokenIn.toLowerCase(), totalAmount: args.totalAmount, tokenOut: null, outputAmount: null })
    } catch {
      // Another event of the FeeCollector (Paused, RouterWhitelisted, ...): not a swap.
    }
  }
  return found
}

/** The router the FeeCollector CALL names (works for a reverted transaction too, which has no event). null: not decodable. */
function feeCollectorCallRouter(input: `0x${string}`): string | null {
  try {
    const call = decodeFunctionData({ abi: FEE_COLLECTOR_ABI, data: input })
    if (call.functionName === 'swapETHWithFee') return call.args[0].toLowerCase()
    if (call.functionName === 'swapTokenWithFee') return call.args[2].toLowerCase()
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

/** Several trades of one wallet in one settlement: a side is derivable only when every trade names the same token. */
function sidesFromCowTrades(trades: readonly CowTrade[]): { in: Side; out: Side } {
  if (trades.length === 0) return NO_SIDES
  const sellTokens = new Set(trades.map((t) => t.sellToken))
  const buyTokens = new Set(trades.map((t) => t.buyToken))
  return {
    in: sellTokens.size === 1 ? { token: trades[0].sellToken, amount: trades.reduce((sum, t) => sum + t.sellAmount, 0n).toString() } : null,
    out: buyTokens.size === 1 ? { token: trades[0].buyToken, amount: trades.reduce((sum, t) => sum + t.buyAmount, 0n).toString() } : null,
  }
}

function rejected(reason: VerifyReason): VerifySwapResult {
  return { outcome: 'rejected', reason }
}

function notFound(reason: VerifyReason): VerifySwapResult {
  return { outcome: 'not_found', reason }
}

export interface VerifyDeps {
  /** The chain read. Tests pass a recorded one; production uses chain-read.ts. */
  read?: ChainRead
}

/**
 * Details A. Two chain reads on the success path (the transaction, then its receipt); none when the input is rejected;
 * one when the transaction is missing, or was sent by another wallet or to another contract (cowswap rows excepted:
 * for them only the receipt can tell).
 */
export async function verifySwapOnChain(input: VerifySwapInput, deps: VerifyDeps = {}): Promise<VerifySwapResult> {
  // A.1: anything that is not one of ours is rejected before any chain read.
  if (!isSwapLogChain(input.chainId)) return rejected('bad_chain')
  if (typeof input.txHash !== 'string' || !TX_HASH_RE.test(input.txHash)) return rejected('bad_tx_hash')
  if (typeof input.wallet !== 'string' || !ADDRESS_RE.test(input.wallet)) return rejected('bad_wallet')
  if (!isSwapLogSource(input.source)) return rejected('bad_source')

  const chainId = input.chainId
  const txHash = input.txHash.toLowerCase()
  const wallet = input.wallet.toLowerCase()
  const read = deps.read ?? readChain

  // A.2: the transaction.
  let rawTx: unknown
  try {
    rawTx = await read(chainId, 'eth_getTransactionByHash', [txHash])
  } catch (err) {
    return notFound(err instanceof ChainReadError ? err.code : 'rpc_error')
  }
  if (rawTx === null || rawTx === undefined) return notFound('tx_missing')
  const tx = parseTx(rawTx)
  if (tx === null || tx.hash !== txHash) return notFound('rpc_malformed')

  // A.4: what the transaction was sent to, decided by the row's chain.
  if (tx.to === null) return rejected('wrong_target')
  const collectors = feeCollectorsOf(chainId)
  const isCurrentCollector = collectors.current !== null && tx.to === collectors.current
  const isV1Collector = collectors.v1 !== null && tx.to === collectors.v1
  const router = routerOf(chainId, input.source)
  const settlement = cowSettlementOf(chainId)

  let kind: VerifiedKind
  if (isCurrentCollector || isV1Collector) kind = 'fee_collector'
  else if (router !== null && tx.to === router) kind = 'router'
  // Not sent to our FeeCollector nor to the source's router: only a cowswap row can still be a swap, and only its
  // receipt (the settlement contract's Trade event, below) can say so.
  else if (input.source === 'cowswap' && settlement !== null) kind = 'cow'
  else return rejected('wrong_target')

  // A.3: the sender is the wallet. For cow the solver sends the transaction: the Trade owner rule below replaces this.
  if (kind !== 'cow' && tx.from !== wallet) return rejected('wrong_sender')

  // A.2: the receipt.
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

  // A.5: the receipt's status, and nothing else, decides between confirmed and failed.
  const outcome: VerifyOutcome = receipt.status === 'success' ? 'confirmed' : 'failed'
  const gas = { gasUsed: receipt.gasUsed, gasPrice: receipt.gasPrice }

  if (kind === 'cow') {
    // settlement is non-null here: kind is 'cow' only for a chain that has one.
    const trades = cowTradesOf(receipt.logs, settlement as string, wallet)
    // A reverted settlement has no Trade either, so it ends here too: a CoW row is confirmed or it is not a CoW row.
    if (trades.length === 0) return rejected('cow_no_trade_for_wallet')
    const sides = sidesFromCowTrades(trades)
    return {
      outcome,
      kind,
      derived: {
        tokenIn: sides.in?.token ?? null,
        amountIn: sides.in?.amount ?? null,
        tokenOut: sides.out?.token ?? null,
        amountOut: sides.out?.amount ?? null,
        source: 'cowswap',
        ...gas,
      },
    }
  }

  if (kind === 'router') {
    const sides = receipt.status === 'success' ? sidesFromTransferLegs(tx, receipt.logs, wallet) : NO_SIDES
    return {
      outcome,
      kind,
      derived: {
        tokenIn: sides.in?.token ?? null,
        amountIn: sides.in?.amount ?? null,
        tokenOut: sides.out?.token ?? null,
        amountOut: sides.out?.amount ?? null,
        // tx.to is this source's router on this chain: the input is proved.
        source: input.source,
        ...gas,
      },
    }
  }

  // kind === 'fee_collector'
  const events = receipt.status === 'success' ? feeCollectorEvents(receipt.logs, tx.to, wallet) : []
  const event = events.length === 1 ? events[0] : null
  let sides: { in: Side; out: Side } = NO_SIDES
  if (receipt.status === 'success') {
    if (event !== null && event.tokenOut !== null && event.outputAmount !== null) {
      sides = {
        in: { token: tokenOrNative(event.tokenIn), amount: event.totalAmount.toString() },
        out: { token: tokenOrNative(event.tokenOut), amount: event.outputAmount.toString() },
      }
    } else if (isV1Collector) {
      sides = sidesFromTransferLegs(tx, receipt.logs, wallet)
    }
  }
  const namedRouter = event?.router ?? feeCollectorCallRouter(tx.input)
  return {
    outcome,
    kind,
    derived: {
      tokenIn: sides.in?.token ?? null,
      amountIn: sides.in?.amount ?? null,
      tokenOut: sides.out?.token ?? null,
      amountOut: sides.out?.amount ?? null,
      source: namedRouter === null ? UNKNOWN_SOURCE : sourceOfRouter(chainId, namedRouter, input.source),
      ...gas,
    },
  }
}
