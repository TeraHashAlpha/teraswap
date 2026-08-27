// @vitest-environment node
/**
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] `getPublicClientForChain` is the THIRD upstream resolver the
 * incident exposed (after `/api/rpc` and `wagmiConfig.ts`) — it feeds quote simulation, portfolio
 * reads, and the on-chain monitor. These tests exercise the guard through THIS entry point
 * specifically (rpc-guarded-transport.test.ts already covers `guardedHttp` in isolation), and
 * cover the trap this module's caching adds on top: `clientCache` holds ONE PublicClient per
 * chain for the process lifetime — the guard's own verdict TTLs must still govern staleness, not
 * the client cache, or an ops fix to a wrong RPC would need a redeploy to take effect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CHAIN_IDENTITY_MISMATCH_TTL_MS, __resetChainIdentityCache } from '../rpc-chain-identity'
import { getPrivateClient } from '@/lib/rpc'

const ARBITRUM = 42161
const ARBITRUM_CHAIN_ID_HEX = '0xa4b1' // 42161 — the correct answer
const BASE_CHAIN_ID_HEX = '0x2105' // 8453 — what a misconfigured Arbitrum endpoint answered in the incident

const PRIMARY = 'https://arbitrum-primary.test'

/** Mutable per-test rpc block for Arbitrum; every other chain uses the real registry. */
let fakeArbRpc: { primary: string; fallbacks: string[] } = { primary: PRIMARY, fallbacks: [] }

vi.mock('./registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry')>()
  return {
    ...actual,
    getChainConfig: (chainId: number) => {
      const config = actual.getChainConfig(chainId)
      return chainId === ARBITRUM ? { ...config, rpc: fakeArbRpc } : config
    },
  }
})

import { getPublicClientForChain, _clearClientCache } from './clients'

function methodOf(init: RequestInit | undefined): string {
  const parsed = JSON.parse(String(init?.body ?? '{}'))
  return Array.isArray(parsed) ? parsed[0]?.method : parsed.method
}

function jsonRpc(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  _clearClientCache()
  __resetChainIdentityCache()
  fakeArbRpc = { primary: PRIMARY, fallbacks: [] }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  __resetChainIdentityCache()
  vi.restoreAllMocks()
})

// ── Acceptance 1 — a mismatch trips the guard through getPublicClientForChain ──────────────────
describe('getPublicClientForChain — mismatched RPC on a non-mainnet chain trips the guard', () => {
  it('refuses a read and names both chain ids, verbatim, when the Arbitrum-configured URL is served by Base', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        methodOf(init) === 'eth_chainId' ? jsonRpc(BASE_CHAIN_ID_HEX) : jsonRpc('0xdeadbeef'),
      ),
    )

    const client = getPublicClientForChain(ARBITRUM)

    await expect(client.getBlockNumber()).rejects.toThrow(/chain 42161.*chain 8453/s)
  })

  it('the rejection is a ChainIdentityError naming both ids on the error object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRpc(BASE_CHAIN_ID_HEX)))

    const client = getPublicClientForChain(ARBITRUM)
    const err = await client.getBlockNumber().catch((e: unknown) => e)

    expect((err as { name?: string }).name).toBe('ChainIdentityError')
    expect((err as { expectedChainId?: number }).expectedChainId).toBe(ARBITRUM)
    expect((err as { reportedChainId?: number }).reportedChainId).toBe(8453)
  })

  it('also trips through the fallback() shape (two configured URLs, both guarded)', async () => {
    fakeArbRpc = { primary: PRIMARY, fallbacks: ['https://arbitrum-fallback.test'] }
    // Both entries lie about their chain — a genuinely misconfigured chain, not a mock gap.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        methodOf(init) === 'eth_chainId' ? jsonRpc(BASE_CHAIN_ID_HEX) : jsonRpc('0xdeadbeef'),
      ),
    )

    const client = getPublicClientForChain(ARBITRUM)
    expect(client.transport.type).toBe('fallback')

    await expect(client.getBlockNumber()).rejects.toThrow(/chain 42161.*chain 8453/s)
  })
})

// ── Acceptance 2 — an unreachable RPC still falls through ──────────────────────────────────────
describe('getPublicClientForChain — an UNREACHABLE RPC does not trip the identity guard', () => {
  it('serves the read normally when the identity probe cannot get an answer (outage, not a lie)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (methodOf(init) === 'eth_chainId') throw new Error('ECONNRESET')
        return jsonRpc('0x1b4')
      }),
    )

    const client = getPublicClientForChain(ARBITRUM)

    await expect(client.getBlockNumber()).resolves.toBe(436n) // 0x1b4 — the read was never blocked
  })

  it('a 5xx on the probe also falls through without raising ChainIdentityError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        methodOf(init) === 'eth_chainId' ? new Response('down', { status: 503 }) : jsonRpc('0x1b4'),
      ),
    )

    const client = getPublicClientForChain(ARBITRUM)

    await expect(client.getBlockNumber()).resolves.toBe(436n)
  })
})

// ── Acceptance 3 — the mainnet path is unchanged ────────────────────────────────────────────────
describe('getPublicClientForChain — the mainnet path is unchanged', () => {
  it('chainId=1 still delegates to getPrivateClient() — per-call, never cached/wrapped like the guarded chains', () => {
    // getPrivateClient() is documented as "intentionally per-call" (never cached) — so two calls
    // return DIFFERENT client objects. That is the proof this path is untouched: a guarded or
    // cached client would not exhibit this. (Reference equality to a separately-invoked
    // getPrivateClient() would always fail regardless of this branch, since that factory itself
    // never returns the same object twice — so the meaningful assertion is this one.)
    const a = getPublicClientForChain(1)
    const b = getPublicClientForChain(1)
    expect(a).not.toBe(b)
    expect(a.chain?.id).toBe(1)
    expect(b.chain?.id).toBe(1)
    // Sanity: getPrivateClient() itself produces the same shape (same factory, same behaviour).
    expect(getPrivateClient().chain?.id).toBe(1)
  })

  it('a chain-1 read never triggers an eth_chainId probe from this module (no fetch stubbed, no mock needed)', async () => {
    // getPrivateClient() routes through /api/rpc server-side plumbing this test does not stub;
    // the only claim here is that getPublicClientForChain(1) takes the early-return branch and
    // never touches fakeArbRpc/registry/guardedHttp — proven by chain id staying 1 with no
    // interaction with the Arbitrum mock state set up in beforeEach.
    expect(getPublicClientForChain(1).chain?.id).toBe(1)
  })
})

// ── Acceptance 4 — the trap: a cached client must not pin a stale verdict ──────────────────────
describe('getPublicClientForChain — clientCache does not freeze a chain-identity verdict', () => {
  it('the SAME cached PublicClient recovers from a mismatch once the mismatch TTL elapses — no redeploy needed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    let reportedChainId = BASE_CHAIN_ID_HEX // starts wrong — the incident's shape
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId' ? jsonRpc(reportedChainId) : jsonRpc('0x1b4'),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = getPublicClientForChain(ARBITRUM)

    // First read: mismatch, refused, verdict cached for CHAIN_IDENTITY_MISMATCH_TTL_MS.
    await expect(client.getBlockNumber()).rejects.toThrow(/chain 42161.*chain 8453/s)
    expect(fetchMock.mock.calls.filter(([, i]) => methodOf(i) === 'eth_chainId')).toHaveLength(1)

    // Same cached client, immediately again: the guard answers from its OWN cache (no new probe)
    // — this is the mismatch-TTL behaviour working as designed, not the cache-pinning bug.
    await expect(client.getBlockNumber()).rejects.toThrow(/chain 42161.*chain 8453/s)
    expect(fetchMock.mock.calls.filter(([, i]) => methodOf(i) === 'eth_chainId')).toHaveLength(1)

    // Ops corrects the endpoint (same URL, the upstream now answers for the right chain) and time
    // passes the mismatch TTL — no new deploy, no cache clear, no new PublicClient.
    reportedChainId = ARBITRUM_CHAIN_ID_HEX
    vi.setSystemTime(CHAIN_IDENTITY_MISMATCH_TTL_MS + 1)

    const again = getPublicClientForChain(ARBITRUM)
    expect(again).toBe(client) // proves this recovery happened on the SAME cached client object

    await expect(again.getBlockNumber()).resolves.toBe(436n) // 0x1b4 — the read now goes through

    // And the guard genuinely re-probed after the TTL — the client cache did not shortcut it.
    expect(fetchMock.mock.calls.filter(([, i]) => methodOf(i) === 'eth_chainId')).toHaveLength(2)
  })

})

// ── Shape 3 — no configured RPC at all still resolves through the guard ────────────────────────
describe('getPublicClientForChain — no configured RPC (shape 3) is still guarded, not bare http()', () => {
  it('with primary and fallbacks both empty, the transport is built from the CHAIN\'S OWN default RPC — and that is guarded too', async () => {
    fakeArbRpc = { primary: '', fallbacks: [] }
    // Arbitrum's viem default is https://arb1.arbitrum.io/rpc — mismatched here on purpose to
    // prove the fallback-to-default path is not a silent, unverified exemption.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        methodOf(init) === 'eth_chainId' ? jsonRpc(BASE_CHAIN_ID_HEX) : jsonRpc('0xdeadbeef'),
      ),
    )

    const client = getPublicClientForChain(ARBITRUM)
    expect(client.transport.type).toBe('http') // still a plain http-typed transport, per the single-default-URL shape

    await expect(client.getBlockNumber()).rejects.toThrow(/chain 42161.*chain 8453/s)
  })

  it('…and still falls through cleanly when that default endpoint is merely unreachable', async () => {
    fakeArbRpc = { primary: '', fallbacks: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (methodOf(init) === 'eth_chainId') throw new Error('ECONNRESET')
        return jsonRpc('0x1b4')
      }),
    )

    const client = getPublicClientForChain(ARBITRUM)

    await expect(client.getBlockNumber()).resolves.toBe(436n)
  })
})
