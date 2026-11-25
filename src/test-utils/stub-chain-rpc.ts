/**
 * [ADR-029] A stub RPC for tests that drive the REAL chain read (src/lib/swap-verify/chain-read.ts): it stands in for
 * `fetch`, answers JSON-RPC as a node does, and serves the recorded real transactions of
 * src/lib/__fixtures__/swap-receipts.ts, each only on the chain it was read from.
 *
 * With no RPC_URL_<id> set, the server reads through the public defaults of rpc-env.ts, so the three hosts below are
 * the three chains. Any other request (an oracle read, another host) is refused loudly: a test must mock what it needs.
 */
import { vi } from 'vitest'
import { ALL_SWAP_RECEIPTS, type SwapReceiptFixture } from '@/lib/__fixtures__/swap-receipts'

const HOST_CHAIN: Record<string, number> = {
  'eth.llamarpc.com': 1,
  'mainnet.base.org': 8453,
  'arb1.arbitrum.io': 42161,
}

export interface StubRpcCall {
  chainId: number
  method: string
  hash: string | null
}

export interface StubChainRpcOptions {
  fixtures?: readonly SwapReceiptFixture[]
  /** What an endpoint says its chain id is (default: the chain it stands for). */
  reportedChainId?: (chainId: number) => number
  /** Replace an answer: return `undefined` to answer normally, anything else (null included) is the JSON-RPC result. */
  override?: (call: StubRpcCall) => unknown
  /** Fail a call: `true` answers HTTP 503. */
  fail?: (call: StubRpcCall) => boolean
}

export function installStubChainRpc(options: StubChainRpcOptions = {}) {
  const fixtures = options.fixtures ?? ALL_SWAP_RECEIPTS
  const calls: StubRpcCall[] = []

  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const chainId = HOST_CHAIN[url.host]
    if (chainId === undefined) throw new Error(`stub-chain-rpc: unexpected request to ${url.host}`)
    const body = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] }
    const hash = typeof body.params?.[0] === 'string' ? body.params[0].toLowerCase() : null
    const call: StubRpcCall = { chainId, method: body.method, hash }
    calls.push(call)

    if (options.fail?.(call)) return new Response('unavailable', { status: 503 })
    const overridden = options.override?.(call)
    if (overridden !== undefined) return Response.json({ jsonrpc: '2.0', id: 1, result: overridden })

    if (body.method === 'eth_chainId') {
      const reported = options.reportedChainId ? options.reportedChainId(chainId) : chainId
      return Response.json({ jsonrpc: '2.0', id: 1, result: `0x${reported.toString(16)}` })
    }
    if (body.method === 'eth_getTransactionByHash' || body.method === 'eth_getTransactionReceipt') {
      const found = fixtures.find((f) => f.chainId === chainId && f.hash.toLowerCase() === hash)
      const result = !found ? null : body.method === 'eth_getTransactionByHash' ? found.tx : found.receipt
      return Response.json({ jsonrpc: '2.0', id: 1, result })
    }
    return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } })
  })

  vi.stubGlobal('fetch', stub)

  return {
    calls,
    /** The chain reads of a verification (everything but the chain-id proof). */
    reads: () => calls.filter((c) => c.method !== 'eth_chainId'),
    reset: () => {
      calls.length = 0
    },
  }
}
