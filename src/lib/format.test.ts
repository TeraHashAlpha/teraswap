import { describe, it, expect } from 'vitest'
import {
  formatWithSeparator, stripSeparator, formatDisplay,
  fmtToken, fmtUsd, fmtPct, fmtInt, fmtFixed, fmtGas, fmtGasCost, fmtAddress, fmtDate, fmtRelTime,
} from './format'

const T = ' ' // thin space
const M = '−' // minus

describe('legacy exports (kept)', () => {
  it('formatWithSeparator / stripSeparator / formatDisplay still behave', () => {
    expect(formatWithSeparator('1234567.89')).toBe('1 234 567.89')
    expect(stripSeparator('111 111.5')).toBe('111111.5')
    expect(stripSeparator(`1${T}234`)).toBe('1234')
    expect(formatDisplay(1234.5)).toBe('1 234.5000')
  })
})

describe('fmtToken (§3)', () => {
  const rows: Array<[string, Parameters<typeof fmtToken>, string]> = [
    ['≥1 → 4 dp', [1.71834], '1.7183'],
    ['≥1 keeps trailing zero (§3 example)', [1713.181], `1${T}713.1810`],
    ['≥1000 is still 4 dp (§3 wins over 2 dp)', [1234567.891234], `1${T}234${T}567.8912`],
    ['<1 → 4 significant digits', [0.123456], '0.1235'],
    ['<1 trims trailing zeros', [0.5], '0.5'],
    ['<1 max 8 dp (§3 example)', [0.00006792], '0.00006792'],
    ['<1 cap at 8 dp', [0.00000012345], '0.00000012'],
    ['smallest representable', [0.00000001], '0.00000001'],
    ['below 1e-8 floor (no space)', [0.000000009], '<0.00000001'],
    ['zero', [0], '0'],
    ['negative zero', [-0], '0'],
    ['round-up across 1', [0.99996], '1.0000'],
    ['negative uses U+2212', [-2.5], `${M}2.5000`],
    ['negative <1', [-0.0123456], `${M}0.01235`],
    ['string input', ['1713.181'], `1${T}713.1810`],
    ['string with grouping is re-parsed', [`1${T}713.181`], `1${T}713.1810`],
    ['never scientific (tiny)', [1e-7], '0.0000001'],
    ['never scientific (huge)', [1e21], `1${T}000${T}000${T}000${T}000${T}000${T}000${T}000.0000`],
    ['bigint, 18 decimals', [1_713_181_000_000_000_000_000n, 18], `1${T}713.1810`],
    ['bigint 1 wei at 18 dp → floor', [1n, 18], '<0.00000001'],
    ['bigint 6 decimals', [1_718_300n, 6], '1.7183'],
    ['bigint negative', [-1_500_000_000_000_000_000n, 18], `${M}1.5000`],
    ['bigint zero', [0n, 18], '0'],
    ['NaN', [NaN], '—'],
    ['Infinity', [Infinity], '—'],
    ['undefined', [undefined], '—'],
    ['null', [null], '—'],
    ['empty string', [''], '—'],
    ['garbage string', ['abc'], '—'],
    ['sign opt (+)', [3, 18, { sign: true }], '+3.0000'],
    ['sign opt leaves negatives alone', [-3, 18, { sign: true }], `${M}3.0000`],
    ['exact: bigint keeps all 18 dp', [1_713_181_234_567_890_123n, 18, { exact: true }], `1.713181234567890123`],
    ['exact: bigint trims zeros', [1_500_000_000_000_000_000n, 18, { exact: true }], '1.5'],
    ['exact: string untouched by Number', ['0.123456789012345678', 18, { exact: true }], '0.123456789012345678'],
    ['exact: groups the integer part', ['1234567.5', 18, { exact: true }], `1${T}234${T}567.5`],
  ]
  it.each(rows)('%s', (_n, args, out) => {
    expect(fmtToken(...args)).toBe(out)
  })
})

describe('fmtUsd (§3)', () => {
  const rows: Array<[string, Parameters<typeof fmtUsd>, string]> = [
    ['2 dp with thin-space grouping', [1234.56], `$1${T}234.56`],
    ['§3 example', [0.03], '$0.03'],
    ['zero', [0], '$0.00'],
    ['floor (no space)', [0.004], '<$0.01'],
    ['exactly one cent', [0.01], '$0.01'],
    ['negative U+2212', [-1234.5], `${M}$1${T}234.50`],
    ['negative below a cent', [-0.001], '<$0.01'],
    ['sign for P&L (+)', [12.3, { sign: true }], '+$12.30'],
    ['sign leaves zero unsigned', [0, { sign: true }], '$0.00'],
    ['string', ['99.999'], '$100.00'],
    ['compact K', [12_345, { compact: true }], '$12.3K'],
    ['compact M', [1_234_567, { compact: true }], '$1.23M'],
    ['compact below 1k stays full', [999.5, { compact: true }], '$999.50'],
    ['NaN', [NaN], '—'],
    ['undefined', [undefined], '—'],
  ]
  it.each(rows)('%s', (_n, args, out) => {
    expect(fmtUsd(...args)).toBe(out)
  })
})

describe('fmtPct (§3)', () => {
  const rows: Array<[string, Parameters<typeof fmtPct>, string]> = [
    ['2 dp default', [0.1234], '0.12%'],
    ['trailing zeros trimmed', [0.3], '0.3%'],
    ['trims whole number', [5, 2], '5%'],
    ['custom dp', [12.3456, 1], '12.3%'],
    ['dp 0', [99.5, 0], '100%'],
    ['negative U+2212', [-0.5], `${M}0.5%`],
    ['sign (+)', [0.25, 2, { sign: true }], '+0.25%'],
    ['rounds to zero → no sign', [-0.001], '0%'],
    ['NaN', [NaN], '—'],
    ['undefined', [undefined], '—'],
  ]
  it.each(rows)('%s', (_n, args, out) => {
    expect(fmtPct(...args)).toBe(out)
  })
})

describe('fmtInt / fmtFixed', () => {
  it.each([
    [1234567, `1${T}234${T}567`],
    [0, '0'],
    [-12345, `${M}12${T}345`],
    [12.6, '13'],
    [NaN, '—'],
    [undefined, '—'],
  ] as const)('fmtInt(%s) → %s', (v, out) => {
    expect(fmtInt(v)).toBe(out)
  })
  it.each([
    [1234.5678, 2, `1${T}234.57`],
    [0.36, 1, '0.4'],
    [-0.001, 2, '0.00'],
    [-2, 1, `${M}2.0`],
    [NaN, 2, '—'],
  ] as const)('fmtFixed(%s, %s) → %s', (v, dp, out) => {
    expect(fmtFixed(v, dp)).toBe(out)
  })
})

describe('fmtGas (§3)', () => {
  const rows: Array<[number | undefined | string, string]> = [
    [0.0000012, '0.0000012'],
    [0.0031, '0.0031'],
    [0.0000081, '0.0000081'],
    [0.000008149, '0.0000081'],
    [0.003, '0.003'],
    [0.00123456, '0.0012'],
    [1.2345, '1.2'],
    [123.4, '123'],
    [0.0000000012, '0.0000000012'],
    [0, '0'],
    [NaN, '—'],
    [undefined, '—'],
  ]
  it.each(rows)('fmtGas(%s) → %s', (v, out) => {
    expect(fmtGas(v as number)).toBe(out)
  })
  it('never renders 0.0000 for a non-zero value', () => {
    for (const v of [1e-3, 1e-5, 1e-7, 1e-9, 4.9e-12]) expect(fmtGas(v)).not.toMatch(/^0\.0+$/)
  })
  it('fmtGasCost matches the §3 line', () => {
    expect(fmtGasCost(0.0000081, 0.03)).toBe('~0.0000081 ETH ($0.03)')
    expect(fmtGasCost(0.0031)).toBe('~0.0031 ETH')
    expect(fmtGasCost(0.0031, 0.001)).toBe('~0.0031 ETH (<$0.01)')
  })
})

describe('fmtAddress (§3)', () => {
  const lower = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
  const checksum = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
  it('checksums the body, lowercase 0x', () => {
    expect(fmtAddress(lower)).toBe(checksum)
    expect(fmtAddress(checksum)).toBe(checksum)
  })
  it('short = 0x + 4 … 4', () => {
    expect(fmtAddress(lower, { short: true })).toBe('0xd8dA…6045')
  })
  it('non-address strings pass through (ENS)', () => {
    expect(fmtAddress('vitalik.eth')).toBe('vitalik.eth')
  })
  it('empty / undefined → —', () => {
    expect(fmtAddress('')).toBe('—')
    expect(fmtAddress(undefined)).toBe('—')
    expect(fmtAddress(null)).toBe('—')
  })
})

describe('fmtDate / fmtRelTime (§3)', () => {
  it('fmtDate: `12 Oct 2026, 14:05` (UTC)', () => {
    expect(fmtDate(Date.UTC(2026, 9, 12, 14, 5), { utc: true })).toBe('12 Oct 2026, 14:05')
    expect(fmtDate('2026-01-05T03:07:00Z', { utc: true })).toBe('5 Jan 2026, 03:07')
  })
  it('fmtDate: invalid → —', () => {
    expect(fmtDate('nope')).toBe('—')
    expect(fmtDate(undefined)).toBe('—')
  })
  const now = Date.UTC(2026, 9, 12, 14, 5)
  it.each([
    [now - 30_000, 'just now'],
    [now - 2 * 60_000, '2m ago'],
    [now - 3 * 3_600_000, '3h ago'],
    [now - 5 * 86_400_000, '5d ago'],
    [now + 60_000, 'just now'],
  ])('fmtRelTime(%s)', (t, out) => {
    expect(fmtRelTime(t, now)).toBe(out)
  })
  it('fmtRelTime: invalid → —', () => {
    expect(fmtRelTime('nope', now)).toBe('—')
  })
})

describe('locale independence', () => {
  it('output is identical regardless of process locale', () => {
    // No Intl / toLocaleString anywhere in the formatter: same string for de-DE-style inputs.
    expect(fmtToken(1234.5)).toBe(`1${T}234.5000`)
    expect(fmtUsd(1234.5)).toBe(`$1${T}234.50`)
  })
})

describe('per-buy consistency (§3: same value, same formatter, summary == review)', () => {
  // DCAPanel summary derives per-buy via perChunkRaw; OrderReviewModal via amountIn / dcaTotal.
  it.each([
    ['1', 18, 10],
    ['100', 6, 3],
    ['0.5', 18, 7],
    ['1234.56789', 18, 9],
  ])('total %s (%s dp) / %s buys renders identically', async (total, dec, buys) => {
    const { parseUnits } = await import('viem')
    const { perChunkRaw } = await import('./dca-quick-fill')
    const raw = parseUnits(total, dec)
    expect(fmtToken(perChunkRaw(raw, buys), dec)).toBe(fmtToken(raw / BigInt(buys), dec))
  })
})
