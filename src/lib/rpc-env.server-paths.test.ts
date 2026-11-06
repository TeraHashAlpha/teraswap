// @vitest-environment node
/**
 * [FEAT-SERVER-RPC-ENV-SPLIT] PROOF, per chain, at the point the URL is handed to the transport.
 *
 *  - SET:   with RPC_URL_<id> set, every server path passes exactly that URL to `http()` /
 *           `guardedHttp()`, and the resolver never even READS a NEXT_PUBLIC_* RPC name
 *           (process.env access spy) — the browser key is not touched.
 *  - UNSET: with RPC_URL_<id> unset, the URL is the browser env's / public default, i.e. what
 *           the code did before the split (the pre-existing suites also pass unchanged).
 *
 * Distinct sentinel values per name so a leak is attributable. Placeholders only — no real keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const httpUrls: string[] = []
const guardedUrls: Array<{ url: string; chainId: number }> = []

vi.mock('viem', async (orig) => {
  const actual = await orig<typeof import('viem')>()
  return { ...actual, http: (url?: string, ...rest: unknown[]) => { httpUrls.push(String(url)); return (actual.http as (...a: unknown[]) => unknown)(url, ...rest) } }
})
vi.mock('@/lib/rpc-guarded-transport', async (orig) => {
  const actual = await orig<typeof import('@/lib/rpc-guarded-transport')>()
  return { ...actual, guardedHttp: (url: string, chainId: number, ...rest: unknown[]) => { guardedUrls.push({ url, chainId }); return (actual.guardedHttp as (...a: unknown[]) => unknown)(url, chainId, ...rest) } }
})

const SRV = { 1: 'https://srv-1.test', 8453: 'https://srv-8453.test', 42161: 'https://srv-42161.test' } as const
const PUB = { 1: 'https://pub-1.test', 8453: 'https://pub-8453.test', 42161: 'https://pub-42161.test' } as const
const NAMES = ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL', 'NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL', 'NEXT_PUBLIC_ARBITRUM_RPC_URL']
const saved: Record<string, string | undefined> = {}
const realEnv = process.env

function setEnv(server: boolean) {
  for (const n of NAMES) delete process.env[n]
  process.env.NEXT_PUBLIC_RPC_URL = PUB[1]
  process.env.NEXT_PUBLIC_BASE_RPC_URL = PUB[8453]
  process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL = PUB[42161]
  if (server) { process.env.RPC_URL_1 = SRV[1]; process.env.RPC_URL_8453 = SRV[8453]; process.env.RPC_URL_42161 = SRV[42161] }
}

/** Records every NEXT_PUBLIC_*RPC* property READ on process.env while `fn` runs. */
async function spyBrowserReads<T>(fn: () => Promise<T> | T): Promise<{ result: T; reads: string[] }> {
  const reads: string[] = []
  process.env = new Proxy(realEnv, {
    get(t, p, r) { if (typeof p === 'string' && /^NEXT_PUBLIC_.*RPC/.test(p)) reads.push(p); return Reflect.get(t, p, r) },
  })
  try { return { result: await fn(), reads } } finally { process.env = realEnv }
}

beforeEach(() => {
  for (const n of NAMES) saved[n] = process.env[n]
  httpUrls.length = 0; guardedUrls.length = 0
  vi.resetModules()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  process.env = realEnv
  for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n] }
  vi.restoreAllMocks()
})

describe('RPC_URL_<id> SET — no server path uses a NEXT_PUBLIC_* RPC', () => {
  it('adapters/shared: getRpcUrl + getRpcUrlForChain (the /api/rpc upstream, chainlink, uniswapv3, curve)', async () => {
    setEnv(true)
    const shared = await import('@/lib/adapters/shared')
    const { result, reads } = await spyBrowserReads(() => [1, 8453, 42161].map((id) => shared.getRpcUrlForChain(id)))
    expect(result).toEqual([SRV[1], SRV[8453], SRV[42161]])
    expect(shared.getRpcUrl()).toBe(SRV[1])
    expect(reads).toEqual([])
  })

  it('rpc.getPrivateClient / getRpcUrl (mainnet SSR + API routes)', async () => {
    setEnv(true)
    const rpc = await import('@/lib/rpc')
    const { reads } = await spyBrowserReads(() => { rpc.getPrivateClient(); return rpc.getRpcUrl() })
    expect(httpUrls).toEqual([SRV[1]])
    expect(rpc.getRpcUrl()).toBe(SRV[1])
    expect(reads).toEqual([])
  })

  it.each([8453, 42161] as const)('chains/clients: getPublicClientForChain(%i) primary is RPC_URL_<id>', async (id) => {
    setEnv(true)
    const { getPublicClientForChain, _clearClientCache } = await import('@/lib/chains/clients')
    _clearClientCache()
    const { reads } = await spyBrowserReads(() => getPublicClientForChain(id))
    expect(guardedUrls[0]).toEqual({ url: SRV[id], chainId: id })
    expect(guardedUrls.map((g) => g.url)).not.toContain(PUB[id])
    expect(reads).toEqual([])
  })
})

describe('RPC_URL_<id> UNSET — behaviour is what it was (browser env, then public default)', () => {
  it('adapters/shared resolves the NEXT_PUBLIC_* values', async () => {
    setEnv(false)
    const shared = await import('@/lib/adapters/shared')
    expect([1, 8453, 42161].map((id) => shared.getRpcUrlForChain(id))).toEqual([PUB[1], PUB[8453], PUB[42161]])
  })

  it('legacy RPC_URL still wins over NEXT_PUBLIC_RPC_URL for mainnet only', async () => {
    setEnv(false)
    process.env.RPC_URL = 'https://legacy.test'
    const shared = await import('@/lib/adapters/shared')
    expect(shared.getRpcUrlForChain(1)).toBe('https://legacy.test')
    expect(shared.getRpcUrlForChain(8453)).toBe(PUB[8453])
  })

  it('nothing configured at all: public defaults, exactly as today', async () => {
    setEnv(false)
    for (const n of NAMES) delete process.env[n]
    const shared = await import('@/lib/adapters/shared')
    expect([1, 8453, 42161].map((id) => shared.getRpcUrlForChain(id))).toEqual([
      'https://eth.llamarpc.com', 'https://mainnet.base.org', 'https://arb1.arbitrum.io/rpc',
    ])
  })

  it('chains/clients builds the same transport inputs (browser env primary + registry fallback)', async () => {
    setEnv(false)
    const { getPublicClientForChain, _clearClientCache } = await import('@/lib/chains/clients')
    _clearClientCache()
    getPublicClientForChain(8453)
    expect(guardedUrls.map((g) => g.url)).toEqual([PUB[8453], 'https://mainnet.base.org'])
  })
})
