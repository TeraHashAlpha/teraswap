import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import type { NormalizedQuote } from '@/lib/adapters/types'
import { buildQuoteView, priceImpact, quoteIsForAmount, routeHopLabel, routeText } from './quote-model'
import { ETH, USDC, fixtureMeta, NO_ORACLE } from './test-fixtures'

const THIN = ' '
const base = { tokenIn: ETH, tokenOut: USDC, amountIn: '1', slippage: 0.3, chainId: 1 }
const gas = () => ({ eth: 0.000012, usd: 0.03 })

describe('route: names, never addresses', () => {
  const addr = '0x1f98431c8ad98523631ae4a59f267346ea31f984'
  it('a hop that is an address falls back to the source label', () => {
    expect(routeHopLabel(addr, 'uniswapv3')).toBe('Uniswap V3')
    expect(routeHopLabel(addr.toUpperCase().replace('0X', '0x'), 'velora')).toBe('Velora')
  })
  it('a hop that merely CONTAINS an address (v1 let this through) falls back too', () => {
    expect(routeHopLabel(`Pool ${addr}`, 'velora')).toBe('Velora')
    expect(routeHopLabel(`${addr}/500`, '0x')).toBe('0x/Matcha')
  })
  it('names pass through verbatim, joined by " + "; an empty route is the source label', () => {
    expect(routeText(fixtureMeta().best)).toBe('Dexalot + PancakeSwap V3 + Dexalot')
    expect(routeText({ ...fixtureMeta().best, routes: [] })).toBe('Velora')
    expect(routeText({ ...fixtureMeta().best, routes: ['', 'Curve'] })).toBe('Velora + Curve')
  })
  it('no 0x ever reaches the Route text, whatever the hop', () => {
    const hops = [addr, `via ${addr}`, 'Dexalot', '']
    const quote: NormalizedQuote = { ...fixtureMeta().best, routes: hops }
    expect(routeText(quote)).not.toMatch(/0x/i)
  })
})

describe('numbers go through @/lib/format (README §3)', () => {
  const v = buildQuoteView({ ...base, meta: fixtureMeta(), tokenInUsdPrice: 2490, gasEstimate: gas })

  it('rate: ≥ 1 → 4 dp, thin-space thousands; the inverse the same', () => {
    expect(v.rate).toBe(`2${THIN}487.6842`)
    expect(v.inverseRate).toBe('0.000402') // < 1 → 4 significant digits (0.0004020), trailing zero trimmed
  })
  it('gas: USD first, ETH at 2 significant digits, never 0.0000', () => {
    expect(v.gas).toBe('$0.03 (~0.000012 ETH)')
    const tiny = buildQuoteView({ ...base, meta: fixtureMeta(), gasEstimate: () => ({ eth: 0.0000081, usd: 0.004 }) })
    expect(tiny.gas).toBe('<$0.01 (~0.0000081 ETH)')
    expect(tiny.gas).not.toMatch(/0\.0000(?!\d)/)
  })
  it('gas without a price source falls back to units, grouped with a thin space', () => {
    expect(buildQuoteView({ ...base, meta: fixtureMeta() }).gas).toBe(`~210${THIN}000 gas`)
  })
  it('platform fee: "(0.1%)" in the label, token + USD in the value', () => {
    expect(v.feeLabel).toBe('Platform fee (0.1%)')
    expect(v.feeValue).toBe('0.001 ETH ($2.49)')
  })
  it('slippage is a trimmed percentage', () => {
    expect(v.slippage).toBe('0.3%')
    expect(buildQuoteView({ ...base, meta: fixtureMeta(), slippage: 1 }).slippage).toBe('1%')
  })
  it('delta is "+Δ TOKEN vs second best", only while the runner-up is strictly worse', () => {
    expect(v.delta).toBe('+0.6547 USDC vs KyberSwap')
    const tie = fixtureMeta()
    tie.all[1] = { ...tie.all[1], toAmount: tie.best.toAmount }
    expect(buildQuoteView({ ...base, meta: tie }).delta).toBeNull()
  })
  it('a malformed toAmount renders — instead of throwing (10-L-01)', () => {
    const m = fixtureMeta()
    m.all[2] = { ...m.all[2], toAmount: 'not-a-number' }
    expect(buildQuoteView({ ...base, meta: m }).compare[2].amount).toBe('—')
  })
})

describe('Min. output is the on-chain derivation, not a float', () => {
  it('equals floor(toAmount × (10000 − bps) / 10000) formatted exactly', () => {
    const v = buildQuoteView({ ...base, meta: fixtureMeta(), gasEstimate: gas })
    // 2 487 684 200 × 9 970 / 10 000 = 2 480 221 147.4 → floor → 2 480.221147 USDC → 4 dp
    expect(v.minOutput).toBe(`2${THIN}480.2211`)
  })
  it('a 14-digit integer part: the bps arithmetic is bigint, every integer digit survives', () => {
    const big = fixtureMeta()
    const huge = (10n ** 20n + 7n).toString() // 100 000 000 000 000 USDC + 7 wei, at 6 dp
    big.all[0] = { ...big.all[0], toAmount: huge }
    big.best = big.all[0]
    const v = buildQuoteView({ ...base, meta: big })
    expect(v.minOutput.startsWith(`99${THIN}700${THIN}000${THIN}000${THIN}000`)).toBe(true) // 99 700 000 000 000.0000
  })
  it('an unusable quote shows — (never a fabricated floor of 0)', () => {
    const m = fixtureMeta()
    m.best = { ...m.best, toAmount: '0' }
    expect(buildQuoteView({ ...base, meta: m }).minOutput).toBe('—')
  })
})

describe('compare rows', () => {
  const v = buildQuoteView({ ...base, meta: fixtureMeta() })
  it('one row per source, the first is best', () => {
    expect(v.compare.map((r) => r.label)).toEqual(['Velora', 'KyberSwap', 'SushiSwap', 'Uniswap V3', '0x/Matcha'])
    expect(v.compare.map((r) => r.isBest)).toEqual([true, false, false, false, false])
  })
  it('flags: Direct, Quote only (chain-aware), pool fee', () => {
    const by = Object.fromEntries(v.compare.map((r) => [r.source, r]))
    expect(by.uniswapv3.direct).toBe(true)
    expect(by.uniswapv3.poolFee).toBe('0.05%')
    expect(by.sushiswap.quoteOnly).toBe(true) // quote-only on Ethereum (executable-sources.ts)
    expect(by.velora.quoteOnly).toBe(false)
    // …and executable on a chain whose map has no entry for it (Arbitrum)
    expect(buildQuoteView({ ...base, chainId: 42161, meta: fixtureMeta() }).compare.find((r) => r.source === 'sushiswap')?.quoteOnly).toBe(false)
  })
})

describe('quoteIsForAmount (the v2 stale-amount rule)', () => {
  const raw = parseUnits('1', 18).toString()
  it('true only for the amount the quote answered', () => {
    expect(quoteIsForAmount(raw, '1', 18)).toBe(true)
    expect(quoteIsForAmount(raw, '1.0', 18)).toBe(true)
    expect(quoteIsForAmount(raw, '1.5', 18)).toBe(false)
  })
  it('fails closed on a missing identity, an empty field, or an unparsable amount', () => {
    expect(quoteIsForAmount(undefined, '1', 18)).toBe(false)
    expect(quoteIsForAmount(raw, '', 18)).toBe(false)
    expect(quoteIsForAmount(raw, '1.2.3', 18)).toBe(false)
    // viem rounds surplus decimals exactly as useQuote does when it builds the identity, so the two always agree
    expect(quoteIsForAmount(raw, '1.0000000000000000001', 18)).toBe(true)
  })
})

describe('price impact row (v1 rule: reference present AND deviation > 0.5 %)', () => {
  it('hidden without a reference or below the floor; toned by the v1 thresholds', () => {
    expect(priceImpact({ ...NO_ORACLE, level: 'none' })).toBeNull()
    expect(priceImpact({ ...NO_ORACLE, chainlinkPrice: 2500, executionPrice: 2490, deviation: 0.004 })).toBeNull()
    expect(priceImpact({ ...NO_ORACLE, chainlinkPrice: 2500, executionPrice: 2490, deviation: 0.01 })).toEqual({ text: '~1%', tone: 'plain' })
    expect(priceImpact({ ...NO_ORACLE, chainlinkPrice: 2500, executionPrice: 2490, deviation: 0.025 })?.tone).toBe('warn')
    expect(priceImpact({ ...NO_ORACLE, chainlinkPrice: 2500, executionPrice: 2490, deviation: 0.04 })?.tone).toBe('danger')
  })
})
