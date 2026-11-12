// @vitest-environment jsdom
/**
 * [fix/user-ip-privacy] In the BROWSER, no transport and no per-chain client names a provider host.
 *
 * Before: Base and Arbitrum read straight from the URL in NEXT_PUBLIC_{BASE,ARBITRUM}_RPC_URL (then a
 * public endpoint), so every L2 read handed the visitor's IP — and the key in that URL — to the
 * provider. Now all three chains read through our own origin's /api/rpc.
 *
 * The env vars are SET to provider URLs for this whole file: the assertion is that the browser does
 * not use them even when they are present (which is the production state until the owner deletes them).
 *
 * Second half: the URLs are absolute, because wagmi's WalletConnect connector copies them into the
 * provider's rpcMap and WalletConnect's EVM provider throws on a relative one while a freshly approved
 * session is being set up. That is reproduced here against the real @walletconnect/universal-provider,
 * with the rpcMap built exactly as wagmi builds it from this config.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { UniversalProvider } from '@walletconnect/universal-provider'
import type { Chain } from 'viem'

const PROVIDER_ENV = {
  NEXT_PUBLIC_RPC_URL: 'https://eth-mainnet.g.alchemy.example/v2/BROWSER-KEY-ETH',
  NEXT_PUBLIC_BASE_RPC_URL: 'https://base-mainnet.g.alchemy.example/v2/BROWSER-KEY-BASE',
  NEXT_PUBLIC_ARBITRUM_RPC_URL: 'https://arb-mainnet.g.alchemy.example/v2/BROWSER-KEY-ARB',
  NEXT_PUBLIC_FALLBACK_RPC_1: 'https://rpc.ankr.example/eth',
  NEXT_PUBLIC_FALLBACK_RPC_2: 'https://ethereum-rpc.publicnode.example',
  RPC_URL_1: 'https://server-eth.example/v2/SERVER-KEY',
  RPC_URL_8453: 'https://server-base.example/v2/SERVER-KEY',
  RPC_URL_42161: 'https://server-arb.example/v2/SERVER-KEY',
}

type WagmiConfigModule = typeof import('./wagmiConfig')
let config: WagmiConfigModule['config']

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  for (const [k, v] of Object.entries(PROVIDER_ENV)) vi.stubEnv(k, v)
  vi.resetModules()
  config = (await import('./wagmiConfig')).config
})

afterAll(() => {
  vi.unstubAllEnvs()
})

type TransportValue = { url?: string; transports?: Array<{ value?: TransportValue }> }

/** Every URL a wagmi transport can dial for `chain` — a single http transport, or each entry of a fallback. */
function transportUrls(chain: Chain): string[] {
  const transports = (config as unknown as { _internal: { transports: Record<number, (a: { chain: Chain }) => { value?: TransportValue }> } })._internal.transports
  const walk = (value: TransportValue | undefined): string[] =>
    value?.transports ? value.transports.flatMap((t) => walk(t.value)) : value?.url ? [value.url] : ['<no url>']
  return walk(transports[chain.id]({ chain }).value)
}

const CHAIN_IDS = [1, 8453, 42161] as const

describe('browser wagmi transports [fix/user-ip-privacy]', () => {
  it('runs as a browser (window present) with the provider envs set. The case being pinned', () => {
    expect(typeof window).toBe('object')
    expect(process.env.NEXT_PUBLIC_BASE_RPC_URL).toBe(PROVIDER_ENV.NEXT_PUBLIC_BASE_RPC_URL)
  })

  it.each(CHAIN_IDS)('chain %i: exactly one transport URL, on our own origin, at /api/rpc', (chainId) => {
    const chain = config.chains.find((c) => c.id === chainId)!
    const urls = transportUrls(chain)
    expect(urls).toHaveLength(1)
    const url = new URL(urls[0])
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/api/rpc')
    expect(url.searchParams.get('chainId')).toBe(chainId === 1 ? null : String(chainId))
  })

  it('no transport URL on any chain has a provider host (or any host but ours)', () => {
    const hosts = new Set(config.chains.flatMap((c) => transportUrls(c)).map((u) => new URL(u).host))
    expect([...hosts]).toEqual([window.location.host])
    const all = config.chains.flatMap((c) => transportUrls(c)).join(' ')
    for (const value of Object.values(PROVIDER_ENV)) expect(all).not.toContain(new URL(value).host)
    expect(all).not.toMatch(/alchemy|infura|llamarpc|ankr|publicnode|base\.org|arbitrum\.io|KEY/i)
  })
})

describe('browser per-chain clients (chains/clients.ts, adapters/shared.ts) [fix/user-ip-privacy]', () => {
  it.each([8453, 42161])('getPublicClientForChain(%i) is a single http transport to /api/rpc?chainId=', async (chainId) => {
    const { getPublicClientForChain, _clearClientCache } = await import('./chains/clients')
    _clearClientCache()
    const client = getPublicClientForChain(chainId)
    expect(client.chain?.id).toBe(chainId)
    expect(client.transport.type).toBe('http') // not a fallback: a second entry would be a third-party host
    const url = new URL((client.transport as unknown as { url: string }).url)
    expect(url.origin).toBe(window.location.origin)
    expect(`${url.pathname}${url.search}`).toBe(`/api/rpc?chainId=${chainId}`)
  })

  it.each([8453, 42161])('getRpcUrlForChain(%i) is the proxy, not the provider', async (chainId) => {
    const { getRpcUrlForChain } = await import('./adapters/shared')
    const url = new URL(getRpcUrlForChain(chainId))
    expect(url.origin).toBe(window.location.origin)
    expect(`${url.pathname}${url.search}`).toBe(`/api/rpc?chainId=${chainId}`)
  })

  it('getRpcUrlForChain(1) is unchanged (/api/rpc) and an unsupported chain still throws', async () => {
    const { getRpcUrlForChain } = await import('./adapters/shared')
    expect(getRpcUrlForChain(1)).toBe('/api/rpc')
    expect(() => getRpcUrlForChain(10)).toThrow()
  })

  it('the legacy L2 env names resolve to nothing in the browser', async () => {
    const { browserRpcEnvUrl, serverRpcEnvUrl } = await import('./rpc-env')
    expect(browserRpcEnvUrl(8453)).toBeUndefined()
    expect(browserRpcEnvUrl(42161)).toBeUndefined()
    // and the server-only names are still plain literal reads (set above), which Next never inlines:
    expect(serverRpcEnvUrl(8453)).toBe(PROVIDER_ENV.RPC_URL_8453)
  })
})

describe('WalletConnect accepts the rpcMap wagmi builds from these transports [fix/user-ip-privacy]', () => {
  const store = new Map<string, unknown>()
  const noop = () => {}
  /** The least a UniversalProvider needs from a SignClient to build its per-namespace providers. */
  const fakeSignClient = {
    core: {
      projectId: 'p',
      storage: { getItem: async (k: string) => store.get(k), setItem: async (k: string, v: unknown) => void store.set(k, v), removeItem: async (k: string) => void store.delete(k) },
      relayer: { on: noop },
    },
    session: { get: noop, getAll: () => [], length: 0, keys: [] },
    pairing: { getAll: () => [] },
    on: noop,
    once: noop,
    off: noop,
    removeListener: noop,
  }
  const WALLET = '0x000000000000000000000000000000000000dEaD'

  /** wagmi's walletConnect connector: `rpcMap[chain.id] = extractRpcUrls({ chain, transports })[0]`. */
  const wagmiRpcMap = () => Object.fromEntries(config.chains.map((c) => [c.id, transportUrls(c)[0]]))

  async function createSessionProviders(rpcMap: Record<number, string>) {
    const provider = await UniversalProvider.init({ client: fakeSignClient as never, projectId: 'p', logger: 'silent' })
    const p = provider as unknown as {
      session: unknown
      namespaces: unknown
      optionalNamespaces: unknown
      createProviders: () => void
      rpcProviders: { eip155: { httpProviders: Record<string, unknown> } }
    }
    p.session = { topic: 't', namespaces: { eip155: { accounts: CHAIN_IDS.map((id) => `eip155:${id}:${WALLET}`), methods: ['eth_sendTransaction'], events: [] } } }
    p.namespaces = {}
    p.optionalNamespaces = { eip155: { chains: CHAIN_IDS.map((id) => `eip155:${id}`), methods: ['eth_sendTransaction'], events: [], rpcMap } }
    p.createProviders()
    return Object.keys(p.rpcProviders.eip155.httpProviders).map(Number).sort((a, b) => a - b)
  }

  it('builds an HTTP provider for all three chains from our transport URLs', async () => {
    await expect(createSessionProviders(wagmiRpcMap())).resolves.toEqual([1, 8453, 42161])
  })

  it('control: the same session with RELATIVE proxy paths throws (what `/api/rpc` did before)', async () => {
    const relative = { 1: '/api/rpc', 8453: '/api/rpc?chainId=8453', 42161: '/api/rpc?chainId=42161' }
    await expect(createSessionProviders(relative)).rejects.toThrow(/not compatible with HTTP connection: \/api\/rpc/)
  })
})
