/**
 * [fix/functional-chain-ui F2] KyberSwap route labels. The adapter used to emit each hop's `pool`
 * (a pool ADDRESS) as the route name, so the quote's Route row read "0xe0554a47…". Driven by REAL
 * recorded `/routes` responses (src/lib/__fixtures__/kyberswap-routes-mainnet.ts); network mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import kyberswap, { kyberHopLabel } from './kyberswap'
import {
  KYBER_ROUTES_WETH_USDC_1,
  KYBER_ROUTES_WETH_USDC_2000,
} from '@/lib/__fixtures__/kyberswap-routes-mainnet'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const ANY_HEX_ADDRESS = /0x[0-9a-fA-F]{40}/

function mockRoutesResponse(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('kyberswap fetchQuote route labels (recorded fixture)', () => {
  it('names the 1-WETH hop by its `exchange`, not its pool address', async () => {
    const hop = KYBER_ROUTES_WETH_USDC_1.data.routeSummary.route[0][0]
    // Pin the recorded shape this fix relies on: `pool` IS an address, `exchange` IS the name.
    expect(hop.pool).toMatch(/^0x[0-9a-f]{40}$/)
    expect(hop.exchange).toBe('uniswapv3')

    const fetchMock = mockRoutesResponse(KYBER_ROUTES_WETH_USDC_1)
    const quote = await kyberswap.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 1 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(quote?.routes).toEqual(['uniswapv3'])
    expect(quote?.routes.join(' + ')).not.toContain(hop.pool)
  })

  it('labels the first path of the split 2000-WETH route by exchange and never renders hex', async () => {
    mockRoutesResponse(KYBER_ROUTES_WETH_USDC_2000)
    const quote = await kyberswap.fetchQuote({ src: WETH, dst: USDC, amount: '2000000000000000000000', chainId: 1 })

    expect(quote?.routes).toEqual(['hashflow-v3/uniswapv3'])
    for (const label of quote?.routes ?? []) expect(label).not.toMatch(ANY_HEX_ADDRESS)
  })

  it('every recorded hop resolves to a non-hex venue name', () => {
    const hops = [
      ...KYBER_ROUTES_WETH_USDC_1.data.routeSummary.route.flat(),
      ...KYBER_ROUTES_WETH_USDC_2000.data.routeSummary.route.flat(),
    ]
    expect(hops.map(kyberHopLabel)).toEqual([
      'uniswapv3',
      'hashflow-v3/uniswapv3',
      'pmm-1/uniswapv3',
      'metric-propamm/uniswapv3',
      'uniswap-v4-stable-stable',
      'fluid-dex-t1',
    ])
  })
})

describe('kyberHopLabel fallbacks', () => {
  it('falls back to poolType when exchange is missing', () => {
    expect(kyberHopLabel({ pool: '0xe0554a476a092703abdb3ef35c80e0d76d32939f', poolType: 'uniswapv3' })).toBe('uniswapv3')
  })

  it("falls back to 'KyberSwap' when neither field is usable or a field carries an address", () => {
    expect(kyberHopLabel({ pool: '0xe0554a476a092703abdb3ef35c80e0d76d32939f' })).toBe('KyberSwap')
    expect(kyberHopLabel({ exchange: '', poolType: '  ' })).toBe('KyberSwap')
    expect(kyberHopLabel({ exchange: '0xe0554a476a092703abdb3ef35c80e0d76d32939f' })).toBe('KyberSwap')
    expect(kyberHopLabel({ exchange: 42 })).toBe('KyberSwap')
    expect(kyberHopLabel(null)).toBe('KyberSwap')
  })

  it("an empty route still yields ['KyberSwap']", async () => {
    mockRoutesResponse({ code: 0, data: { routeSummary: { amountOut: '1', gas: '1', gasUsd: '0.1', route: [] } } })
    const quote = await kyberswap.fetchQuote({ src: WETH, dst: USDC, amount: '1', chainId: 1 })
    expect(quote?.routes).toEqual(['KyberSwap'])
  })
})
