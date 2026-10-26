/**
 * [feat/swap-price-tiers] Pure, import-free helpers shared by the server route, the swap route and the
 * browser: the pair tier from two leg tiers (D2/D3: the BEST leg decides — one priced leg is enough to
 * size the trade), the source label for the single-source notice, and the response parser the client
 * uses (anything malformed is "unknown", never a guessed tier — D1: the client is never stricter).
 */
import { describe, it, expect } from 'vitest'
import { combinePairTier, parseSwapPriceTierResponse, singleSourceLabel, UNPRICED_PAIR, type SwapPriceLeg } from './swap-price-tier'

const priced = (usd: number, agreementBps = 10): SwapPriceLeg => ({ tier: 'priced', sources: ['defillama', 'coingecko'], usd, agreementBps })
const single = (source: SwapPriceLeg['sources'][number], usd = 1): SwapPriceLeg => ({ tier: 'single-source', sources: [source], usd })
const unpriced = (sources: SwapPriceLeg['sources'] = []): SwapPriceLeg => ({ tier: 'unpriced', sources })

describe('combinePairTier — the best leg decides', () => {
  it('both priced -> priced; agreementBps = the WORSE leg agreement', () => {
    expect(combinePairTier(priced(1, 12), priced(2, 250))).toEqual({ tier: 'priced', legs: { in: priced(1, 12), out: priced(2, 250) }, agreementBps: 250 })
  })
  it('one priced leg + anything -> priced (D2: thresholds apply from the priced value)', () => {
    expect(combinePairTier(priced(1, 7), unpriced()).tier).toBe('priced')
    expect(combinePairTier(single('defillama'), priced(1, 7))).toMatchObject({ tier: 'priced', agreementBps: 7 })
  })
  it('no priced leg, >= 1 single-source leg -> single-source, no agreementBps', () => {
    const r = combinePairTier(single('coingecko'), unpriced(['defillama', 'coingecko']))
    expect(r.tier).toBe('single-source')
    expect(r.agreementBps).toBeUndefined()
  })
  it('neither leg priced nor single -> unpriced (D3: consent, not a block)', () => {
    expect(combinePairTier(unpriced(), unpriced(['defillama', 'coingecko'])).tier).toBe('unpriced')
  })
})

describe('singleSourceLabel — names the source(s) behind a single-source pair', () => {
  it('one single-source leg -> that vendor', () => {
    expect(singleSourceLabel(combinePairTier(single('defillama'), unpriced()))).toBe('DefiLlama')
  })
  it('two single-source legs from different vendors -> both, trust order, deduped', () => {
    expect(singleSourceLabel(combinePairTier(single('coingecko'), single('chainlink')))).toBe('Chainlink / CoinGecko')
    expect(singleSourceLabel(combinePairTier(single('coingecko'), single('coingecko')))).toBe('CoinGecko')
  })
  it('not a single-source pair -> empty', () => {
    expect(singleSourceLabel(combinePairTier(priced(1), single('defillama')))).toBe('')
  })
})

describe('parseSwapPriceTierResponse — the browser trusts only a well-formed answer', () => {
  it('accepts the server shape (extra fields ignored, numbers validated)', () => {
    const body = { tier: 'single-source', legs: { in: { tier: 'single-source', sources: ['defillama'], usd: 0.69 }, out: { tier: 'unpriced', sources: [] } }, extra: 1 }
    expect(parseSwapPriceTierResponse(body)).toEqual({ tier: 'single-source', legs: { in: { tier: 'single-source', sources: ['defillama'], usd: 0.69 }, out: { tier: 'unpriced', sources: [] } } })
  })
  it('rejects an unknown tier, an unknown source, a non-finite usd, or a missing leg -> null (unknown, never a guess)', () => {
    expect(parseSwapPriceTierResponse({ tier: 'blocked', legs: { in: unpriced(), out: unpriced() } })).toBeNull()
    expect(parseSwapPriceTierResponse({ tier: 'priced', legs: { in: { tier: 'priced', sources: ['binance'], usd: 1 }, out: unpriced() } })).toBeNull()
    expect(parseSwapPriceTierResponse({ tier: 'priced', legs: { in: { tier: 'priced', sources: ['defillama'], usd: 'x' }, out: unpriced() } })).toBeNull()
    expect(parseSwapPriceTierResponse({ tier: 'priced', legs: { in: unpriced() } })).toBeNull()
    expect(parseSwapPriceTierResponse(null)).toBeNull()
    expect(parseSwapPriceTierResponse('unpriced')).toBeNull()
  })
  it('UNPRICED_PAIR is the fail-closed server answer and parses', () => {
    expect(parseSwapPriceTierResponse(UNPRICED_PAIR)).toEqual(UNPRICED_PAIR)
    expect(UNPRICED_PAIR.tier).toBe('unpriced')
  })
})
