// @vitest-environment node
/**
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] The SERVER-side mainnet transport.
 *
 * wagmiConfig builds a different mainnet transport with no `window`: the browser gets the
 * `/api/rpc` proxy, the server hits its own resolver directly. That branch is unreachable from
 * wagmiConfig.test.ts, which runs in jsdom — and a relative URL cannot even be turned into a
 * `Request` outside a browser, so the browser branch is equally unreachable from here. Hence two files.
 *
 * [fix/mainnet-rpc-out-of-client, SEC-5] The server resolver is rpc-env's `serverRpcUrl(1)` (RPC_URL_1, then
 * RPC_URL, then llamarpc), the same builder Base and Arbitrum use. It used to be NEXT_PUBLIC_RPC_URL (then the two
 * NEXT_PUBLIC_FALLBACK_RPC_* names): a literal read in a module the browser reaches, so the value was in a client chunk.
 * The browser-era name is set below to a different value and must not be the URL this transport dials.
 *
 * This pins the same invariant on the server ladder: an endpoint that answers for another chain is
 * refused; an endpoint that cannot answer at all is an outage and still serves the read.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'

const PRIMARY_RPC = 'https://eth-primary.example.test/v2/secret-key'
const BASE_CHAIN_ID_HEX = '0x2105'

type WagmiConfigModule = typeof import('./wagmiConfig')
let config: WagmiConfigModule['config']
let __resetChainIdentityCache: () => void

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  vi.stubEnv('RPC_URL_1', PRIMARY_RPC)
  vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://browser-era.invalid/v2/IGNORED-BY-THE-SERVER')
  vi.stubEnv('NEXT_PUBLIC_FALLBACK_RPC_1', '')
  vi.stubEnv('NEXT_PUBLIC_FALLBACK_RPC_2', '')
  config = (await import('./wagmiConfig')).config
  __resetChainIdentityCache = (await import('./rpc-chain-identity')).__resetChainIdentityCache
})

afterAll(() => {
  vi.unstubAllEnvs()
})

const jsonRpc = (result: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const methodOf = (init: RequestInit | undefined): string => {
  const parsed = JSON.parse(String(init?.body ?? '{}'))
  return Array.isArray(parsed) ? parsed[0]?.method : parsed.method
}

beforeEach(() => {
  __resetChainIdentityCache()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  __resetChainIdentityCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('wagmiConfig (server): mainnet transport identity guard', () => {
  it('refuses the read when RPC_URL_1 is served by another chain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        methodOf(init) === 'eth_chainId' ? jsonRpc(BASE_CHAIN_ID_HEX) : jsonRpc('0xdeadbeef'),
      ),
    )

    const client = config.getClient({ chainId: 1 })
    const err = await client.request({ method: 'eth_blockNumber' }).catch((e: unknown) => e)

    const text = String((err as Error)?.message ?? err)
    expect(text).toContain('chain 1')
    expect(text).toContain('chain 8453')
    // The refusal must not carry the provider key that lives in the RPC URL path.
    expect(text).not.toContain('secret-key')
  })

  it('never sends the read to the endpoint it just caught lying', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId' ? jsonRpc(BASE_CHAIN_ID_HEX) : jsonRpc('0xdeadbeef'),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = config.getClient({ chainId: 1 })
    await client.request({ method: 'eth_getBalance', params: ['0x0', 'latest'] }).catch(() => {})

    expect(fetchMock.mock.calls.map(([, init]) => methodOf(init))).toEqual(['eth_chainId'])
    // [SEC-5] and the endpoint probed is the server name's, not the browser-era NEXT_PUBLIC_RPC_URL.
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([PRIMARY_RPC])
  })

  it('still serves the read when the probe is UNREACHABLE. An outage is not a lie', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (methodOf(init) === 'eth_chainId') throw new Error('ECONNREFUSED')
        return jsonRpc('0x1b4')
      }),
    )

    const client = config.getClient({ chainId: 1 })
    await expect(client.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1b4')
    expect(console.error).not.toHaveBeenCalled()
  })
})
