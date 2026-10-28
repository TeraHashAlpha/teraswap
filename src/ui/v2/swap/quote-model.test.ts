import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import type { NormalizedQuote } from '@/lib/adapters/types'
import { buildQuoteView, formatGas, priceImpact, quoteIsForAmount, routeHopLabel, routeText } from './quote-model'
import { knownDexName } from './route-names'
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
  it('gas with no live estimate: the quote\'s own USD (v2: USD first whenever a price exists); units only when there is no price at all', () => {
    expect(buildQuoteView({ ...base, meta: fixtureMeta() }).gas).toBe('$0.03') // fixture quotes carry gasUsd 0.03
    const noPrice = fixtureMeta()
    noPrice.best = { ...noPrice.best, gasUsd: 0 }
    noPrice.all = [noPrice.best, ...noPrice.all.slice(1)]
    expect(buildQuoteView({ ...base, meta: noPrice }).gas).toBe(`~210${THIN}000 gas`)
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

describe('route: only known DEX names pass (table)', () => {
  // [hop as an adapter forwards it, source, shown]
  const rows: Array<[string, Parameters<typeof routeHopLabel>[1], string]> = [
    // KyberSwap internal ids and opaque strings → the source's own name
    ['fermi', 'kyberswap', 'KyberSwap'],
    ['metric-v1', 'kyberswap', 'KyberSwap'],
    ['metric-propamm/uniswapv3', 'kyberswap', 'KyberSwap'],
    ['pmm-1/uniswapv3', 'kyberswap', 'KyberSwap'],
    ['hashflow-v3/uniswapv3', 'kyberswap', 'KyberSwap'],
    ['uniswap-v4-stable-stable', 'kyberswap', 'KyberSwap'],
    ['fluid-dex-t1', 'kyberswap', 'KyberSwap'],
    ['0x1f98431c8ad98523631ae4a59f267346ea31f984', 'kyberswap', 'KyberSwap'], // a pool address
    ['0xdeadbeefcafe', 'kyberswap', 'KyberSwap'], // a short hash / id
    ['0x' + 'ab'.repeat(32), 'kyberswap', 'KyberSwap'], // a 32-byte hash
    ['Pool 0xabc', 'kyberswap', 'KyberSwap'],
    ['', 'kyberswap', 'KyberSwap'],
    ['   ', 'kyberswap', 'KyberSwap'],
    // the same ids from another source fall back to THAT source
    ['metric-v1', 'velora', 'Velora'],
    ['fermi', 'sushiswap', 'SushiSwap'],
    // known venues pass, whichever way they are spelled
    ['uniswapv3', 'kyberswap', 'Uniswap V3'],
    ['uniswap-v3', 'kyberswap', 'Uniswap V3'],
    ['Uniswap V3', 'kyberswap', 'Uniswap V3'],
    ['UNISWAPV4', 'kyberswap', 'Uniswap V4'],
    ['pancakeswapv3', 'velora', 'PancakeSwap V3'],
    ['PancakeSwap V3', 'velora', 'PancakeSwap V3'],
    ['curve', 'velora', 'Curve'],
    ['balancerv2', 'velora', 'Balancer'],
    ['aerodrome-slipstream', 'velora', 'Aerodrome Slipstream'],
    ['Dexalot', 'velora', 'Dexalot'],
  ]
  it.each(rows)('%s (%s) → %s', (hop, source, shown) => {
    expect(routeHopLabel(hop, source)).toBe(shown)
  })

  it('a recorded KyberSwap route reads as names: unknown ids collapse into one "KyberSwap", named venues stay', () => {
    const hops = ['uniswapv3', 'hashflow-v3/uniswapv3', 'pmm-1/uniswapv3', 'metric-propamm/uniswapv3', 'uniswap-v4-stable-stable', 'fluid-dex-t1']
    expect(routeText({ ...fixtureMeta().best, source: 'kyberswap', routes: hops })).toBe('Uniswap V3 + KyberSwap')
    expect(routeText({ ...fixtureMeta().best, source: 'kyberswap', routes: ['fermi'] })).toBe('KyberSwap')
    expect(routeText({ ...fixtureMeta().best, source: 'kyberswap', routes: ['fermi', 'metric-v1', '0xabc0abc0abc0'] })).toBe('KyberSwap')
    expect(routeText({ ...fixtureMeta().best, source: 'kyberswap', routes: ['fermi', 'curve', 'metric-v1'] })).toBe('KyberSwap + Curve + KyberSwap')
  })

  it('whatever the hops, the text is only allow-listed names and the source label', () => {
    const hops = ['fermi', 'metric-v1', 'uniswapv3', '0x1234', 'Dexalot', 'x/y/z', 'pmm-1/uniswapv3', 'curve v2', '']
    const text = routeText({ ...fixtureMeta().best, source: 'kyberswap', routes: hops })
    for (const part of text.split(' + ')) expect(part === 'KyberSwap' || knownDexName(part) === part).toBe(true)
  })
})

describe('est. gas: USD first, ETH at 2 significant digits, never "~0"', () => {
  const est = (eth: number, usd: number) => () => ({ eth, usd })
  const zero = () => ({ eth: 0, usd: 0 }) // useEthGasCost.estimate(0): not null, but zero
  const rows: Array<[string, Parameters<typeof formatGas>, string]> = [
    ['live estimate: USD (ETH)', [{ estimatedGas: 210_000, gasUsd: 0.03 }, false, est(0.000012, 0.03)], '$0.03 (~0.000012 ETH)'],
    ['tiny USD keeps the < $0.01 floor, ETH stays 2 sf', [{ estimatedGas: 210_000, gasUsd: 0 }, false, est(0.0000081, 0.004)], '<$0.01 (~0.0000081 ETH)'],
    ['KyberSwap on Ethereum: estimatedGas 0 + gasUsd, ETH from the oracle (the owner\'s ~0 ETH)', [{ estimatedGas: 0, gasUsd: 1.23 }, false, zero, 2490], '$1.23 (~0.00049 ETH)'],
    ['same, estimate fn absent', [{ estimatedGas: 0, gasUsd: 1.23 }, false, undefined, 2490], '$1.23 (~0.00049 ETH)'],
    ['same, no ETH price → USD alone, not a guess', [{ estimatedGas: 0, gasUsd: 1.23 }, false, zero], '$1.23'],
    ['same, estimate returns null (no gas price yet)', [{ estimatedGas: 0, gasUsd: 1.23 }, false, () => null, 2490], '$1.23 (~0.00049 ETH)'],
    ['units known, no price anywhere → v1\'s unit fallback', [{ estimatedGas: 210_000, gasUsd: 0 }, false, undefined], `~210${THIN}000 gas`],
    ['ETH known but no USD (no oracle price) → ETH, 2 sf', [{ estimatedGas: 210_000, gasUsd: 0 }, false, est(0.0031, 0)], '~0.0031 ETH'],
    ['nothing known (0 units, no USD) → a dash, never ~0', [{ estimatedGas: 0, gasUsd: 0 }, false, zero], '—'],
    ['0 units, 0 USD, no estimate → a dash', [{ estimatedGas: 0, gasUsd: 0 }, false, undefined], '—'],
    ['NaN / negative USD is not a price', [{ estimatedGas: 0, gasUsd: Number.NaN }, false, zero], '—'],
    ['intent order (CoW): the solver pays', [{ estimatedGas: 0, gasUsd: 0 }, true, zero], 'Free (solver-paid)'],
  ]
  it.each(rows)('%s', (_name, args, expected) => {
    const out = formatGas(...args)
    expect(out.replace(/[\u00a0\u2009\u202f]/g, ' ')).toBe(expected.replace(/[\u00a0\u2009\u202f]/g, ' '))
    expect(out).not.toMatch(/~0(?![.\d])/) // never "~0 ETH"
  })

  it('through buildQuoteView: a KyberSwap best quote on mainnet', () => {
    const m = fixtureMeta()
    m.best = { ...m.best, source: 'kyberswap', estimatedGas: 0, gasUsd: 1.23 }
    m.all = [m.best, ...m.all.slice(1)]
    const v = buildQuoteView({ ...base, meta: m, tokenInUsdPrice: 2490, gasEstimate: () => ({ eth: 0, usd: 0 }), ethUsdPrice: 2490 })
    expect(v.gas).toBe('$1.23 (~0.00049 ETH)')
    expect(v.gasFree).toBe(false)
  })
})
