import { vi } from 'vitest'
import { classifyDcaFloorDetailed } from '@/lib/order-engine/dca-floor-tier'
import { getOrderExecutorV3 } from '@/lib/order-engine'
import { fetchDefiLlamaPrice } from '@/lib/defillama'

/**
 * [feat/dca-tier-server-side] The browser no longer classifies a DCA pair; it GETs
 * /api/dca-floor-cap?chainId&tokenIn&tokenOut. Panel tests keep their own registry / price mocks
 * (module-level vi.mock of `@/lib/chains/clients` and `@/lib/defillama`) and answer that request with
 * the REAL server-side classifier run over them, so each test still decides the tier the way it did
 * before — only the process boundary moved. Any other fetch falls through to the original.
 */
export function stubFloorEndpoint(opts: { registeredFeedCount?: number | null; failWith?: 'network' | 'status' } = {}) {
  const real = globalThis.fetch
  const calls: string[] = []
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname !== '/api/dca-floor-cap') {
      if (real) return real(input, init)
      throw new Error(`unexpected fetch ${url}`)
    }
    calls.push(url.search)
    if (opts.failWith === 'network') throw new TypeError('Failed to fetch')
    if (opts.failWith === 'status') return { ok: false, status: 500, json: async () => ({}) } as Response
    const chainId = Number(url.searchParams.get('chainId'))
    const c = await classifyDcaFloorDetailed(
      { chainId, tokenIn: url.searchParams.get('tokenIn')!, tokenOut: url.searchParams.get('tokenOut')! },
      {
        executor: getOrderExecutorV3(chainId), // the executor each test's mocked barrel reports
        // Each panel test already scripts its price answer through its `@/lib/defillama` mock; the
        // production source (the DefiLlama + CoinGecko quorum) is covered by dca-price-quorum.test.ts.
        priceUsd: async (address, slug) => (await fetchDefiLlamaPrice(address, slug))?.price ?? null,
      },
    )
    const body = {
      tier: c.tier, legs: c.legs,
      registeredFeedCount: opts.registeredFeedCount ?? null,
      effectiveCap: null, max: 250, maxUsd: 250, effectiveUsd: 250,
    }
    return { ok: true, status: 200, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', stub)
  return { calls, stub }
}
