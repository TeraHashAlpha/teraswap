// @vitest-environment node
/**
 * [fix/mainnet-rpc-out-of-client, SEC-5] The SERVER's mainnet RPC is RPC_URL_1, then RPC_URL, then the public
 * default. It no longer falls back to NEXT_PUBLIC_RPC_URL (nor to NEXT_PUBLIC_FALLBACK_RPC_1/_2), whose value is a
 * browser-era provider URL.
 *
 * Three env states, every server path that resolves a mainnet RPC: rpc-env (serverRpcUrl / rpcEnvSource),
 * adapters/shared getRpcUrlForChain(1), rpc.getPrivateClient (SSR + API routes), the wagmi config's server-side
 * transport, and the /api/rpc route's upstream. "Reads work" = a real read through a fetch stub that answers as
 * mainnet: the test asserts the URL each path dialled and the value it got back.
 *
 * Marker values only (the `.invalid` TLD never resolves); no real key anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/kv-rate-limiter', async (orig) => {
  const actual = await orig<typeof import('@/lib/kv-rate-limiter')>()
  const allow = async () => ({ allowed: true, remaining: 299, resetAt: Date.now() + 60_000 })
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})

const SERVER_URL = 'https://server-mainnet.invalid/v2/SERVER-MARKER-KEY'
const LEGACY_URL = 'https://legacy-mainnet.invalid/v2/LEGACY-MARKER-KEY'
const PUBLIC_DEFAULT = 'https://eth.llamarpc.com'
const BROWSER_ERA = {
  NEXT_PUBLIC_RPC_URL: 'https://mainnet-provider.invalid/v2/CAPTURE-MARKER-MAINNET-RPC-KEY',
  NEXT_PUBLIC_FALLBACK_RPC_1: 'https://fallback1-provider.invalid/v2/CAPTURE-MARKER-FALLBACK-RPC-1-KEY',
  NEXT_PUBLIC_FALLBACK_RPC_2: 'https://fallback2-provider.invalid/v2/CAPTURE-MARKER-FALLBACK-RPC-2-KEY',
}
const NAMES = ['RPC_URL_1', 'RPC_URL', ...Object.keys(BROWSER_ERA)]

const BLOCK_HEX = '0x1b4'
const dialled: string[] = []

function rpcAnswer(body: unknown) {
  const one = (r: { id?: unknown; method?: string }) => ({ jsonrpc: '2.0', id: r?.id ?? 1, result: r?.method === 'eth_chainId' ? '0x1' : BLOCK_HEX })
  return Array.isArray(body) ? body.map(one) : one(body as { id?: unknown; method?: string })
}

beforeEach(() => {
  for (const n of NAMES) vi.stubEnv(n, '')
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  dialled.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      dialled.push(new URL(url).href) // normalised: viem dials a bare origin as `https://host/`
      const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')))
      return new Response(JSON.stringify(rpcAnswer(body)), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Every server path's mainnet resolution plus one real read through each client the server builds. */
async function serverMainnet() {
  const env = await import('@/lib/rpc-env')
  const shared = await import('@/lib/adapters/shared')
  const rpc = await import('@/lib/rpc')
  const { config } = await import('@/lib/wagmiConfig')
  const { POST } = await import('@/app/api/rpc/route')

  const resolved = {
    serverRpcUrl: env.serverRpcUrl(1),
    rpcEnvSource: env.rpcEnvSource(1),
    getRpcUrlForChain: shared.getRpcUrlForChain(1),
    getRpcUrl: rpc.getRpcUrl(),
  }

  dialled.length = 0
  const privateBlock = await rpc.getPrivateClient().getBlockNumber({ cacheTime: 0 })
  const privateDialled = [...new Set(dialled)]

  dialled.length = 0
  const wagmiBlock = await config.getClient({ chainId: 1 }).request({ method: 'eth_blockNumber' })
  const wagmiDialled = [...new Set(dialled)]

  dialled.length = 0
  const res = await POST(
    new NextRequest('http://localhost/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_getBalance', params: ['0x000000000000000000000000000000000000dEaD', 'latest'] }),
    }),
  )
  const proxied = { status: res.status, result: (await res.json()).result }
  const proxyDialled = [...new Set(dialled)]

  return { resolved, privateBlock, privateDialled, wagmiBlock, wagmiDialled, proxied, proxyDialled }
}

const expectAllOn = (url: string, got: Awaited<ReturnType<typeof serverMainnet>>) => {
  expect(got.resolved).toEqual({
    serverRpcUrl: url,
    rpcEnvSource: url === SERVER_URL ? 'RPC_URL_1' : url === LEGACY_URL ? 'RPC_URL' : 'public-default',
    getRpcUrlForChain: url,
    getRpcUrl: url,
  })
  const href = new URL(url).href
  expect([got.privateBlock, got.privateDialled]).toEqual([436n, [href]])
  expect([got.wagmiBlock, got.wagmiDialled]).toEqual([BLOCK_HEX, [href]])
  expect([got.proxied, got.proxyDialled]).toEqual([{ status: 200, result: BLOCK_HEX }, [href]])
}

describe('[SEC-5] server mainnet RPC: RPC_URL_1 → RPC_URL → public default', () => {
  it('only RPC_URL_1 set: every server path reads mainnet through it', async () => {
    vi.stubEnv('RPC_URL_1', SERVER_URL)
    expectAllOn(SERVER_URL, await serverMainnet())
  })

  it('nothing set: every server path reads mainnet through the public default', async () => {
    expectAllOn(PUBLIC_DEFAULT, await serverMainnet())
  })

  it('legacy RPC_URL alone: still the mainnet server name (unchanged)', async () => {
    vi.stubEnv('RPC_URL', LEGACY_URL)
    expectAllOn(LEGACY_URL, await serverMainnet())
  })

  it('NEXT_PUBLIC_RPC_URL (and the two FALLBACK names) set ALONE: ignored. Public default, the marker host is never dialled', async () => {
    for (const [k, v] of Object.entries(BROWSER_ERA)) vi.stubEnv(k, v)
    const got = await serverMainnet()
    expectAllOn(PUBLIC_DEFAULT, got)
    const all = [...got.privateDialled, ...got.wagmiDialled, ...got.proxyDialled].join(' ')
    expect(all).not.toMatch(/provider\.invalid|CAPTURE-MARKER/)
  })

  it('RPC_URL_1 still wins when the browser-era names are also set', async () => {
    for (const [k, v] of Object.entries(BROWSER_ERA)) vi.stubEnv(k, v)
    vi.stubEnv('RPC_URL_1', SERVER_URL)
    expectAllOn(SERVER_URL, await serverMainnet())
  })
})
