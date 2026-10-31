/**
 * [feat/frontend-rpc-diet] Counting JSON-RPC transport for browser-RPC budget tests.
 *
 * The production wagmi `config` is built from `guardedHttp(...)` transports. A test mocks
 * `@/lib/rpc-guarded-transport` with `mockGuardedTransportModule()` so the REAL config, QueryClient and hooks
 * run unchanged while every JSON-RPC request lands in `rpcCounter` instead of the network. One `request()` call =
 * one billed provider call (an `eth_call` to Multicall3 is ONE call however many reads it carries).
 *
 * The responder answers just enough of the chain (balances, ERC-20 / Chainlink / Multicall3 reads, fee data) that
 * no hook errors and retries — a failing mock would inflate the counts with retry traffic.
 */
import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  toHex,
  type Hex,
  type Transport,
} from 'viem'

export interface RpcCounter {
  /** JSON-RPC method → request count since the last reset. */
  byMethod: Record<string, number>
  /** Reads carried inside Multicall3 `aggregate3` calls (informational: NOT billed separately). */
  multicallInner: number
  /** Request count per chain id, so a test can tell Base from mainnet traffic. */
  byChain: Record<number, number>
}

export const rpcCounter: RpcCounter = { byMethod: {}, multicallInner: 0, byChain: {} }

export function resetRpcCounter(): void {
  rpcCounter.byMethod = {}
  rpcCounter.multicallInner = 0
  rpcCounter.byChain = {}
}

export function totalRpcCalls(c: RpcCounter = rpcCounter): number {
  return Object.values(c.byMethod).reduce((a, b) => a + b, 0)
}

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'.toLowerCase()
const ONE_ETH_WEI = 10n ** 18n

// Inline on purpose: importing app modules here would cycle through the mocked `@/lib/rpc-guarded-transport`
// (the vi.mock factory awaits this file) and deadlock module loading.
const chainlinkAggregatorAbi = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  { inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'description', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
] as const

const readAbi = [...erc20Abi, ...chainlinkAggregatorAbi, ...multicall3Abi] as const

const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex

/** Answer a single contract read by selector; unknown selectors get one zero word. */
function answerCall(data: Hex): Hex {
  try {
    const { functionName } = decodeFunctionData({ abi: readAbi, data })
    const now = BigInt(Math.floor(Date.now() / 1000))
    switch (functionName) {
      case 'latestRoundData':
        return encodeFunctionResult({
          abi: chainlinkAggregatorAbi,
          functionName: 'latestRoundData',
          result: [1n, 250_000_000_000n, now, now, 1n],
        })
      case 'decimals':
        return word(8n)
      case 'description':
        return encodeFunctionResult({ abi: chainlinkAggregatorAbi, functionName: 'description', result: 'ETH / USD' })
      case 'getEthBalance':
        return word(ONE_ETH_WEI)
      case 'balanceOf':
        return word(1_000_000_000n)
      case 'allowance':
        return word(0n)
      default:
        return word(0n)
    }
  } catch {
    return word(0n)
  }
}

function answerMulticall(data: Hex): Hex {
  const { args } = decodeFunctionData({ abi: multicall3Abi, data })
  const calls = (args?.[0] ?? []) as readonly { callData: Hex }[]
  rpcCounter.multicallInner += calls.length
  return encodeFunctionResult({
    abi: multicall3Abi,
    functionName: 'aggregate3',
    result: calls.map((c) => ({ success: true, returnData: answerCall(c.callData) })),
  })
}

function fakeBlock(): Record<string, unknown> {
  const number = 20_000_000n + BigInt(Math.floor(Date.now() / 12_000))
  return {
    number: toHex(number),
    hash: `0x${'11'.repeat(32)}`,
    parentHash: `0x${'22'.repeat(32)}`,
    timestamp: toHex(BigInt(Math.floor(Date.now() / 1000))),
    baseFeePerGas: toHex(10n ** 9n),
    gasLimit: toHex(30_000_000n),
    gasUsed: toHex(15_000_000n),
    miner: `0x${'00'.repeat(20)}`,
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    logsBloom: `0x${'00'.repeat(256)}`,
    receiptsRoot: `0x${'00'.repeat(32)}`,
    sha3Uncles: `0x${'00'.repeat(32)}`,
    size: '0x1',
    stateRoot: `0x${'00'.repeat(32)}`,
    transactionsRoot: `0x${'00'.repeat(32)}`,
    transactions: [],
    uncles: [],
  }
}

function respond(chainId: number, method: string, params: unknown): unknown {
  switch (method) {
    case 'eth_chainId':
      return toHex(chainId)
    case 'eth_blockNumber':
      return toHex(20_000_000n + BigInt(Math.floor(Date.now() / 12_000)))
    case 'eth_getBalance':
      return toHex(ONE_ETH_WEI)
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return fakeBlock()
    case 'eth_gasPrice':
      return toHex(10n ** 9n)
    case 'eth_maxPriorityFeePerGas':
      return toHex(10n ** 8n)
    case 'eth_estimateGas':
      return toHex(21_000n)
    case 'eth_getTransactionCount':
      return '0x0'
    case 'eth_call': {
      const tx = (params as [{ to?: string; data?: Hex }])[0]
      const data = (tx.data ?? '0x') as Hex
      return tx.to?.toLowerCase() === MULTICALL3 ? answerMulticall(data) : answerCall(data)
    }
    default:
      return null
  }
}

/** A viem transport for `chainId` that counts every request and answers it from `respond`. */
export function countingTransport(chainId: number): Transport {
  return custom({
    async request({ method, params }) {
      rpcCounter.byMethod[method] = (rpcCounter.byMethod[method] ?? 0) + 1
      rpcCounter.byChain[chainId] = (rpcCounter.byChain[chainId] ?? 0) + 1
      return respond(chainId, method, params)
    },
  })
}

/** Factory body for `vi.mock('@/lib/rpc-guarded-transport', ...)`. */
export function mockGuardedTransportModule() {
  return {
    guardedHttp: (_url: string, chainId: number) => countingTransport(chainId),
  }
}
