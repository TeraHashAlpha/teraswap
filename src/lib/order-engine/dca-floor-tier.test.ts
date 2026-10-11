/**
 * [FEAT-DCA-FLOOR-TIERS] classifyDcaFloor — the three tiers, fail-closed lookup, chain awareness,
 * native→wrapped resolution, and the pin between the UI/server cap and the keeper's cap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BASE_V3 = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'
const ARB_V3 = '0x2222222222222222222222222222222222222222'
vi.mock('./config', async () => {
  const actual = await vi.importActual<typeof import('./config')>('./config')
  return { ...actual, getOrderExecutorV3: (id: number) => (id === 8453 ? BASE_V3 : id === 42161 ? ARB_V3 : null) }
})
vi.mock('@/lib/chains/clients', () => ({ getPublicClientForChain: () => { throw new Error('tests inject a reader') } }))
vi.mock('@/lib/defillama', () => ({ fetchDefiLlamaPrice: vi.fn() }))

import { fetchDefiLlamaPrice } from '@/lib/defillama'
import { classifyDcaFloor, classifyDcaFloorDetailed, DCA_NO_PRICE_FILL_CAP_MAX_USD, effectiveNoPriceCapUsd } from './dca-floor-tier'

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ETHFI = '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB'
const REG = ['0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 8, 18, 3600n, true] as const
const ZERO = ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false] as const

function reader(registered: string[], opts: { throws?: boolean } = {}) {
  const calls: Array<{ address: string; token: string }> = []
  return {
    calls,
    readContract: async ({ address, args }: { address: string; args: readonly unknown[] }) => {
      calls.push({ address, token: String(args[0]).toLowerCase() })
      if (opts.throws) throw new Error('rpc down')
      return registered.map(a => a.toLowerCase()).includes(String(args[0]).toLowerCase()) ? REG : ZERO
    },
  }
}
const priced = (addrs: string[]) => async (a: string) => (addrs.map(x => x.toLowerCase()).includes(a.toLowerCase()) ? 1 : null)

describe('classifyDcaFloor', () => {
  it('onchain-feed: both legs registered in the executor', async () => {
    const r = reader([WETH_BASE, USDC_BASE])
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: r, priceUsd: priced([]) })).toBe('onchain-feed')
  })

  it('offchain-price: not both registered, but every non-WETH leg has an off-chain price', async () => {
    const r = reader([WETH_BASE])
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: ETHFI }, { reader: r, priceUsd: priced([ETHFI]) })).toBe('offchain-price')
  })

  it('unpriced: a leg with neither a registered feed nor an off-chain price', async () => {
    const r = reader([WETH_BASE])
    const out = await classifyDcaFloorDetailed({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: ETHFI }, { reader: r, priceUsd: priced([]) })
    expect(out).toEqual({ tier: 'unpriced', affected: [ETHFI] })
  })

  it('registry lookup failure ⇒ unpriced (never a weaker tier), even when prices exist', async () => {
    const r = reader([], { throws: true })
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: r, priceUsd: priced([USDC_BASE]) })).toBe('unpriced')
  })

  it('price-source failure ⇒ unpriced', async () => {
    const r = reader([WETH_BASE])
    const boom = async () => { throw new Error('llama down') }
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: ETHFI }, { reader: r, priceUsd: boom })).toBe('unpriced')
  })

  it('no executor configured / unsupported chain ⇒ unpriced', async () => {
    expect(await classifyDcaFloor({ chainId: 1, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: reader([]), priceUsd: priced([WETH_BASE, USDC_BASE]) })).toBe('unpriced')
    expect(await classifyDcaFloor({ chainId: 999999, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: reader([]) })).toBe('unpriced')
  })

  it('is chain-aware: the registry is read on EACH chain\'s own V3 executor', async () => {
    const base = reader([])
    await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: base, priceUsd: priced([]) })
    expect(new Set(base.calls.map(c => c.address))).toEqual(new Set([BASE_V3]))
    const arb = reader([])
    await classifyDcaFloor({ chainId: 42161, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: arb, priceUsd: priced([]) })
    expect(new Set(arb.calls.map(c => c.address))).toEqual(new Set([ARB_V3]))
  })

  it('native ETH resolves to that chain\'s WETH (registry asked about WETH, never the sentinel)', async () => {
    const r = reader([WETH_BASE, USDC_BASE])
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: NATIVE, tokenOut: USDC_BASE }, { reader: r, priceUsd: priced([]) })).toBe('onchain-feed')
    expect(r.calls.map(c => c.token)).toContain(WETH_BASE.toLowerCase())
    expect(r.calls.map(c => c.token)).not.toContain(NATIVE.toLowerCase())
  })

  it('WETH needs no DefiLlama price (Chainlink prices it): WETH unregistered ⇒ offchain-price, and WETH itself is never looked up', async () => {
    const r = reader([USDC_BASE])
    const lookups: string[] = []
    const priceUsd = async (a: string) => { lookups.push(a); return 1 }
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: r, priceUsd })).toBe('offchain-price')
    expect(lookups).toEqual([USDC_BASE]) // only the non-WETH leg is looked up
  })
})

/**
 * [fix/dca-consent-copy-and-tier-check] Production showed `unpriced` for AAVE and UNI. These run the
 * REAL fetchDefiLlamaPrice (the classifier's default price source) against the responses DefiLlama
 * actually returned on 2026-10-11, so the whole off-chain path — coin key, parse, confidence — is the
 * production one; only the network and the executor registry are stubbed.
 */
describe('off-chain price path with captured DefiLlama responses', () => {
  const WETH_ARB = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
  const AAVE_ARB = '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196'
  const AAVE_BASE = '0x63706e401c06ac8513145b7687A14804d17f814b'
  const UNI_BASE = '0xc3De830EA07524a0761646a6a4e4be0e114a3C83'
  const captured = (key: string, symbol: string, price: number) =>
    ({ coins: { [key]: { decimals: 18, symbol, price, timestamp: 1791713879, confidence: 0.99 } } })
  const urls: string[] = []
  const serve = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => body } }))

  beforeEach(async () => {
    urls.length = 0
    const actual = await vi.importActual<typeof import('@/lib/defillama')>('@/lib/defillama')
    vi.mocked(fetchDefiLlamaPrice).mockImplementation(actual.fetchDefiLlamaPrice)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.mocked(fetchDefiLlamaPrice).mockReset() })

  it('a real-priced token with no on-chain feed is offchain-price, never unpriced (AAVE on 42161 and 8453)', async () => {
    for (const c of [
      { chainId: 42161, weth: WETH_ARB, token: AAVE_ARB, key: `arbitrum:${AAVE_ARB.toLowerCase()}` },
      { chainId: 8453, weth: WETH_BASE, token: AAVE_BASE, key: `base:${AAVE_BASE.toLowerCase()}` },
    ]) {
      urls.length = 0
      serve(captured(c.key, 'AAVE', 167.32572402703212))
      const out = await classifyDcaFloorDetailed({ chainId: c.chainId, tokenIn: c.weth, tokenOut: c.token }, { reader: reader([c.weth]) })
      expect(out).toEqual({ tier: 'offchain-price', affected: [c.token] })
      expect(urls).toEqual([`https://coins.llama.fi/prices/current/${c.key}`])
    }
  })

  it('the production failure mode: a browser-blocked fetch (CSP → TypeError) reads unpriced, naming only that leg', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const out = await classifyDcaFloorDetailed({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: UNI_BASE }, { reader: reader([WETH_BASE]) })
    expect(out).toEqual({ tier: 'unpriced', affected: [UNI_BASE] })
  })

  it('the origin the classifier fetches is allowed by the CSP connect-src in next.config.js', async () => {
    serve(captured(`base:${UNI_BASE.toLowerCase()}`, 'UNI', 7.557033308837781))
    await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: UNI_BASE }, { reader: reader([WETH_BASE]) })
    const connectSrc = readFileSync(resolve(__dirname, '../../../next.config.js'), 'utf8').match(/"connect-src ([^"]+)"/)?.[1].split(/\s+/) ?? []
    expect(urls).toHaveLength(1)
    expect(connectSrc).toContain(new URL(urls[0]).origin)
  })
})

describe('DCA_NO_PRICE_FILL_CAP_MAX_USD', () => {
  it('equals the keeper\'s DCA_FAIL_OPEN_MAX_USD (order-floor.js:188) — imported value AND source text', async () => {
    const path = resolve(__dirname, '../../../contracts/order-engine/executor/order-floor.js')
    const keeper = await import(/* @vite-ignore */ pathToFileURL(path).href)
    expect(DCA_NO_PRICE_FILL_CAP_MAX_USD).toBe(keeper.DCA_FAIL_OPEN_MAX_USD)
    const m = readFileSync(path, 'utf8').match(/export const DCA_FAIL_OPEN_MAX_USD\s*=\s*(\d[\d_]*)/)
    expect(Number(m?.[1].replace(/_/g, ''))).toBe(DCA_NO_PRICE_FILL_CAP_MAX_USD)
  })
})

describe('effectiveNoPriceCapUsd', () => {
  it('is min(row, MAX); MAX for no row / junk; never above MAX', () => {
    expect(effectiveNoPriceCapUsd(100)).toBe(100)
    expect(effectiveNoPriceCapUsd('100')).toBe(100)
    expect(effectiveNoPriceCapUsd(10_000)).toBe(DCA_NO_PRICE_FILL_CAP_MAX_USD)
    for (const junk of [undefined, null, 0, -5, NaN, Infinity, 'abc', {}]) {
      expect(effectiveNoPriceCapUsd(junk)).toBe(DCA_NO_PRICE_FILL_CAP_MAX_USD)
    }
  })
})
