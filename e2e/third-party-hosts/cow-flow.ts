/**
 * [fix/user-ip-privacy A76 S-1] Same-origin answers that let the CoW capture drive the app to a SIGNED CoW order on
 * Ethereum, with nothing leaving the machine:
 *
 *  - /api/rpc → an ABI-aware JSON-RPC stub. The swap gates read real-looking chain state through it: ERC-20 balances
 *    and allowances (wagmi batches them through Multicall3 aggregate3, decoded and answered call by call), and the
 *    Chainlink legs, which must self-identify (description() + decimals() against the repo's own FEED_EXPECTATIONS —
 *    ADR-018) and return a fresh round. ETH/USD answers $3 000, every other feed $1.
 *  - /api/quote → a meta-quote whose best source is CoW, priced at the same $3 000 so no price gate fires.
 *  - /api/swap → CoW order parameters for the requested pair, receiver = the signer; /api/spender → CoW's VaultRelayer.
 *  - /api/cow/orders → an order uid; /api/cow/order-status → fulfilled; /api/cow/trades → one settlement.
 *    These stand in for CoW's orderbook BEHIND our relay; the point of the scenario is what the BROWSER contacts.
 *
 * The answers are deliberately boring: the scenario measures hosts and CSP refusals, not prices.
 */
import {
  decodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem'
import { getFeedExpectation } from '../../src/lib/chains/chainlink-feeds'
import type { ApiOverride } from './rig'

const ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])
const PERMIT2_ALLOWANCE = parseAbi(['function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'])

const SELECTOR = (signature: string) => toFunctionSelector(signature)
const SEL_PERMIT2_ALLOWANCE = SELECTOR('allowance(address,address,address)')

/** The USDC on Ethereum (6 decimals); every other token answers 18. */
const USDC_MAINNET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const ETH_USD = 3_000
const BIG = 10n ** 30n
const MAX_UINT256 = 2n ** 256n - 1n

/** One eth_call: the encoded result, or null for "execution reverted". */
function answerCall(to: string, data: Hex): Hex | null {
  const target = to.toLowerCase()
  if (data.startsWith(SEL_PERMIT2_ALLOWANCE)) {
    return encodeFunctionResult({ abi: PERMIT2_ALLOWANCE, functionName: 'allowance', result: [2n ** 160n - 1n, 2 ** 40, 0] })
  }
  let call: ReturnType<typeof decodeFunctionData<typeof ABI>>
  try {
    call = decodeFunctionData({ abi: ABI, data })
  } catch {
    return null
  }
  const feed = getFeedExpectation(target)
  switch (call.functionName) {
    case 'aggregate3': {
      const results = call.args[0].map((c) => {
        const r = answerCall(c.target, c.callData)
        return { success: r !== null, returnData: r ?? '0x' }
      })
      return encodeFunctionResult({ abi: ABI, functionName: 'aggregate3', result: results })
    }
    case 'getEthBalance':
      return encodeFunctionResult({ abi: ABI, functionName: 'getEthBalance', result: BIG })
    case 'balanceOf':
      return encodeFunctionResult({ abi: ABI, functionName: 'balanceOf', result: BIG })
    case 'allowance':
      return encodeFunctionResult({ abi: ABI, functionName: 'allowance', result: MAX_UINT256 })
    case 'totalSupply':
      return encodeFunctionResult({ abi: ABI, functionName: 'totalSupply', result: BIG })
    case 'symbol':
      return encodeFunctionResult({ abi: ABI, functionName: 'symbol', result: 'TKN' })
    case 'name':
      return encodeFunctionResult({ abi: ABI, functionName: 'name', result: 'Token' })
    case 'decimals':
      return encodeFunctionResult({ abi: ABI, functionName: 'decimals', result: feed ? feed.decimals : target === USDC_MAINNET ? 6 : 18 })
    case 'description':
      return feed ? encodeFunctionResult({ abi: ABI, functionName: 'description', result: feed.description }) : null
    case 'latestRoundData': {
      if (!feed) return null
      const usd = feed.description.startsWith('ETH / USD') ? ETH_USD : 1
      const now = BigInt(Math.floor(Date.now() / 1000) - 30)
      const round = (1n << 64n) + 1n
      return encodeFunctionResult({ abi: ABI, functionName: 'latestRoundData', result: [round, BigInt(usd) * 10n ** BigInt(feed.decimals), now, now, round] })
    }
  }
  return null
}

const hex = (n: number | bigint) => `0x${n.toString(16)}`

function answerRpc(chainId: number, rpc: { id?: unknown; method?: string; params?: unknown[] }) {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: rpc?.id ?? null, result })
  const now = Math.floor(Date.now() / 1000)
  switch (rpc?.method) {
    case 'eth_chainId':
      return ok(hex(chainId))
    case 'net_version':
      return ok(String(chainId))
    case 'eth_blockNumber':
      return ok(hex(23_541_870))
    case 'eth_getBalance':
      return ok(hex(BIG))
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return ok(hex(1_000_000_000))
    case 'eth_estimateGas':
      return ok(hex(200_000))
    case 'eth_getTransactionCount':
      return ok('0x0')
    case 'eth_getCode':
      return ok('0x60')
    case 'eth_feeHistory':
      return ok({ oldestBlock: hex(23_541_860), baseFeePerGas: Array(11).fill(hex(1_000_000_000)), gasUsedRatio: Array(10).fill(0.5), reward: Array(10).fill([hex(1_000_000)]) })
    case 'eth_getBlockByNumber':
      return ok({ number: hex(23_541_870), hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'2'.repeat(64)}`, timestamp: hex(now), baseFeePerGas: hex(1_000_000_000), gasLimit: hex(30_000_000), gasUsed: hex(15_000_000), transactions: [] })
    case 'eth_call': {
      const [tx] = (rpc.params ?? []) as Array<{ to?: string; data?: Hex; input?: Hex }>
      const result = tx?.to ? answerCall(tx.to, (tx.data ?? tx.input ?? '0x') as Hex) : null
      return result === null ? { jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: 3, message: 'execution reverted', data: '0x' } } : ok(result)
    }
    default:
      return ok('0x')
  }
}

export const COW_ORDER_UID = `0x${'c0'.repeat(56)}`
export const COW_SETTLEMENT_TX = `0x${'5e'.repeat(32)}`
const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

/** Output for `amount` of `src` at $1 per input unit and ETH = $3 000 (both legs priced like the stub feeds). */
function quotedOut(src: string, dst: string, amount: string, srcDecimals: number, dstDecimals: number): bigint {
  const usdIn = (Number(amount) / 10 ** srcDecimals) * (src.toLowerCase() === NATIVE || src.toLowerCase() === WETH_MAINNET.toLowerCase() ? ETH_USD : 1)
  const unitsOut = usdIn / (dst.toLowerCase() === NATIVE || dst.toLowerCase() === WETH_MAINNET.toLowerCase() ? ETH_USD : 1)
  return BigInt(Math.floor(unitsOut * 10 ** Math.min(dstDecimals, 15))) * 10n ** BigInt(Math.max(dstDecimals - 15, 0))
}

/** The full override: RPC, quote, swap build and CoW's side of the relay. */
export const cowFlowOverride: ApiOverride = (url, request) => {
  if (url.pathname === '/api/rpc') {
    const chainId = Number(url.searchParams.get('chainId') ?? '1')
    const body = request.json()
    return { status: 200, json: Array.isArray(body) ? body.map((b) => answerRpc(chainId, b)) : answerRpc(chainId, body as never) }
  }
  if (url.pathname === '/api/quote') {
    const q = url.searchParams
    const src = q.get('src') ?? ''
    const dst = q.get('dst') ?? ''
    const amount = q.get('amount') ?? '0'
    const decimalsIn = Number(q.get('srcDecimals') ?? '18')
    const decimalsOut = Number(q.get('dstDecimals') ?? '18')
    const best = { source: 'cowswap', toAmount: quotedOut(src, dst, amount, decimalsIn, decimalsOut).toString(), estimatedGas: 0, gasUsd: 0, routes: ['CoW Protocol'] }
    return {
      status: 200,
      json: { best, all: [best], fetchedAt: Date.now(), tokenIn: src, tokenOut: dst, chainId: Number(q.get('chainId') ?? '1'), decimalsIn, decimalsOut, amountIn: amount },
    }
  }
  if (url.pathname === '/api/swap') {
    const b = (request.json() ?? {}) as { src?: string; dst?: string; amount?: string; from?: string; srcDecimals?: number; dstDecimals?: number }
    const out = quotedOut(b.src ?? '', b.dst ?? '', b.amount ?? '0', b.srcDecimals ?? 18, b.dstDecimals ?? 18)
    const toWrapped = (a?: string) => (a?.toLowerCase() === NATIVE ? WETH_MAINNET : a)
    return {
      status: 200,
      json: {
        source: 'cowswap',
        toAmount: out.toString(),
        estimatedGas: 0,
        gasUsd: 0,
        routes: ['CoW Protocol'],
        cowOrderParams: {
          sellToken: toWrapped(b.src),
          buyToken: toWrapped(b.dst),
          sellAmount: b.amount,
          buyAmount: ((out * 995n) / 1000n).toString(),
          validTo: Math.floor(Date.now() / 1000) + 600,
          appData: JSON.stringify({ version: '1.1.0', appCode: 'TeraSwap', metadata: {} }),
          appDataHash: `0x${'a'.repeat(64)}`,
          feeAmount: '0',
          kind: 'sell',
          partiallyFillable: false,
          receiver: b.from,
          sellTokenBalance: 'erc20',
          buyTokenBalance: 'erc20',
          from: b.from,
          quoteId: 1,
          signingScheme: 'eip712',
        },
      },
    }
  }
  // v1 asks which contract to approve for the best source; for CoW that is its VaultRelayer (allowance stub: unlimited).
  if (url.pathname === '/api/spender' && url.searchParams.get('source') === 'cowswap') return { status: 200, json: { spender: COW_VAULT_RELAYER } }
  if (url.pathname === '/api/cow/orders') return { status: 201, json: COW_ORDER_UID }
  if (url.pathname === '/api/cow/order-status') return { status: 200, json: { uid: COW_ORDER_UID, status: 'fulfilled' } }
  if (url.pathname === '/api/cow/trades') return { status: 200, json: [{ orderUid: COW_ORDER_UID, txHash: COW_SETTLEMENT_TX, executedBuyAmount: '1' }] }
  return null
}
