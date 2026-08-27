// @vitest-environment node
/**
 * [CHORE-POLISH-3 P3] Base RPC fallback transport in getPublicClientForChain.
 *
 * Separate file from clients.test.ts ON PURPOSE: that file runs with the REAL
 * registry (and is the mainnet-delegation pin); THIS file mocks the registry's
 * Base rpc block so the failover path is deterministic. Before this change,
 * non-mainnet clients were built from a single http(primary) transport — the
 * registry's configured fallback RPCs were never used, so a degraded Base
 * primary failed ALL Base reads (quote simulation / portfolio / monitor).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { __resetChainIdentityCache } from '../rpc-chain-identity'

const PRIMARY = 'https://base-primary.test'
const FALLBACK = 'https://base-fallback.test'
const BASE_CHAIN_ID_HEX = '0x2105' // 8453 — what a correctly-identified endpoint answers

/** Reads the JSON-RPC method name off a viem http transport's fetch call. */
function methodOf(init: RequestInit | undefined): string {
  const parsed = JSON.parse(String(init?.body ?? '{}'))
  return Array.isArray(parsed) ? parsed[0]?.method : parsed.method
}

// Mutable per-test rpc block for Base; chain 1 and everything else stay real.
let fakeBaseRpc: { primary: string; fallbacks: string[] } = {
  primary: PRIMARY,
  fallbacks: [FALLBACK],
}

vi.mock('./registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry')>()
  return {
    ...actual,
    getChainConfig: (chainId: number) => {
      const config = actual.getChainConfig(chainId)
      return chainId === 8453 ? { ...config, rpc: fakeBaseRpc } : config
    },
  }
})

import { getPublicClientForChain, _clearClientCache } from './clients'

beforeEach(() => {
  _clearClientCache()
  __resetChainIdentityCache()
  fakeBaseRpc = { primary: PRIMARY, fallbacks: [FALLBACK] }
})

afterEach(() => {
  vi.unstubAllGlobals()
  __resetChainIdentityCache()
})

describe('chains/clients — Base RPC fallback [CHORE-POLISH-3 P3]', () => {
  it('builds a fallback transport from primary + registry fallbacks for Base', () => {
    const client = getPublicClientForChain(8453)
    expect(client.transport.type).toBe('fallback')
  })

  // [FIX-RPC-CHAIN-IDENTITY-GUARD] Both URLs now sit behind guardedHttp, so the mock must answer
  // eth_chainId correctly (0x2105) for both hosts — an uncontrolled answer here would read as a
  // chain mismatch, not the HTTP-error failover this test is about.
  it('fails over to the registry fallback RPC when the Base primary errors', async () => {
    // Exact parsed-host comparison (not substring/prefix matching) — more
    // precise for a URL-dispatching mock and avoids the CodeQL
    // js/incomplete-url-substring-sanitization pattern.
    const hostOf = (u: string) => new URL(u).host
    const seenHosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const host = hostOf(String(url))
      seenHosts.push(host)
      if (methodOf(init) === 'eth_chainId') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: BASE_CHAIN_ID_HEX }),
          { status: 200 },
        )
      }
      if (host === hostOf(PRIMARY)) {
        // 401 is a deterministic HTTP error → viem fails over without retries.
        return new Response('Unauthorized', { status: 401 })
      }
      const body = JSON.parse(String(init?.body)) as { id: number }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x1e240' }),
        { status: 200 },
      )
    }))

    const block = await getPublicClientForChain(8453).getBlockNumber()

    expect(block).toBe(123456n) // 0x1e240 — served by the FALLBACK transport
    expect(seenHosts).toContain(hostOf(PRIMARY))
    expect(seenHosts).toContain(hostOf(FALLBACK))
  })

  it('keeps a single configured URL as a plain http-typed transport (still guarded — guardedHttp preserves transport.type)', () => {
    fakeBaseRpc = { primary: PRIMARY, fallbacks: [] }
    const client = getPublicClientForChain(8453)
    expect(client.transport.type).toBe('http')
  })

  it('still caches the fallback-wrapped client (same object on repeat calls)', () => {
    const a = getPublicClientForChain(8453)
    const b = getPublicClientForChain(8453)
    expect(a).toBe(b)
  })

  it('mainnet (chainId 1) is untouched — still the getPrivateClient path, never fallback-wrapped', () => {
    const client = getPublicClientForChain(1)
    expect(client.chain?.id).toBe(1)
    expect(client.transport.type).not.toBe('fallback')
  })
})
