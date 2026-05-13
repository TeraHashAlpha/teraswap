/**
 * [P100] Tests for the CSV export route.
 *
 * The route itself depends on Supabase + rate-limiting, which would mean
 * heavy mock setup for limited extra coverage. The interesting logic —
 * CSV escaping, header order, wei → human conversion, ISO dates,
 * gasless flag rendering — lives in the exported helpers, so the
 * tests target those directly.
 */

import { describe, it, expect } from 'vitest'
import { csvEscape, rowsToCsv } from './route'

describe('csvEscape', () => {
  it('passes plain values through unchanged', () => {
    expect(csvEscape('1inch')).toBe('1inch')
    expect(csvEscape(42)).toBe('42')
    expect(csvEscape(true)).toBe('true')
  })

  it('returns empty string for null/undefined', () => {
    expect(csvEscape(null)).toBe('')
    expect(csvEscape(undefined)).toBe('')
  })

  it('wraps and escapes values containing commas, quotes, or newlines', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""')
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
    expect(csvEscape('crlf\r\nok')).toBe('"crlf\r\nok"')
  })
})

describe('rowsToCsv', () => {
  it('returns header-only CSV for an empty wallet', () => {
    const csv = rowsToCsv([])
    const lines = csv.split('\r\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(
      'Date,Pair,Source,Amount In,Token In,Amount Out,Token Out,Volume USD,Gas USD,Gas Saved USD,Gasless,TX Hash',
    )
  })

  it('renders one ISO-8601 dated row per swap', () => {
    const csv = rowsToCsv([
      {
        created_at: '2026-05-13T14:32:09.000Z',
        source: '1inch',
        token_in_symbol: 'USDC',
        token_out_symbol: 'ETH',
        amount_in: '1000000000',   // 1000 USDC (6dp)
        amount_out: '500000000000000000', // 0.5 ETH (18dp)
        amount_in_usd: 1000,
        gas_used: null,
        gas_savings_usd: 0,
        is_gasless: false,
        tx_hash: '0xabc',
      },
    ])
    const lines = csv.split('\r\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    const [, dataLine] = lines
    const cells = dataLine.split(',')
    // Date is ISO-8601 with milliseconds + 'Z'.
    expect(cells[0]).toMatch(/^2026-05-13T14:32:09\.000Z$/)
    // Pair
    expect(cells[1]).toBe('USDC/ETH')
    // Source
    expect(cells[2]).toBe('1inch')
    // Amounts converted from raw to decimal — not the original wei strings.
    expect(cells[3]).toBe('1000')      // 1000 USDC
    expect(cells[4]).toBe('USDC')
    expect(cells[5]).toBe('0.5')       // 0.5 ETH
    expect(cells[6]).toBe('ETH')
    // Volume / gas-saved
    expect(cells[7]).toBe('1000')
    expect(cells[9]).toBe('0')
    expect(cells[10]).toBe('false')
    expect(cells[11]).toBe('0xabc')
  })

  it('renders gasless=true and gas_savings_usd verbatim for a CoW swap', () => {
    const csv = rowsToCsv([
      {
        created_at: '2026-05-13T14:32:09.000Z',
        source: 'cowswap',
        token_in_symbol: 'USDC',
        token_out_symbol: 'ETH',
        amount_in: '1000000000',
        amount_out: '500000000000000000',
        amount_in_usd: 1000,
        gas_used: null,
        gas_savings_usd: 4.20,
        is_gasless: true,
        tx_hash: '0xdef',
      },
    ])
    const dataLine = csv.split('\r\n')[1]
    const cells = dataLine.split(',')
    expect(cells[9]).toBe('4.2')
    expect(cells[10]).toBe('true')
  })

  it('passes already-decimal amounts through (legacy rows)', () => {
    const csv = rowsToCsv([
      {
        created_at: '2026-05-13T14:32:09.000Z',
        source: '1inch',
        token_in_symbol: 'USDC',
        token_out_symbol: 'ETH',
        amount_in: '1000.5',    // legacy: already human
        amount_out: '0.42',
        amount_in_usd: 1000,
        gas_used: null,
        gas_savings_usd: 0,
        is_gasless: false,
        tx_hash: '0xabc',
      },
    ])
    const cells = csv.split('\r\n')[1].split(',')
    expect(cells[3]).toBe('1000.5')
    expect(cells[5]).toBe('0.42')
  })

  it('escapes commas/quotes inside cell values', () => {
    // A token symbol with a comma in it (theoretical / future) should be
    // properly escaped so the CSV stays parseable.
    const csv = rowsToCsv([
      {
        created_at: '2026-05-13T14:32:09.000Z',
        source: 'evil,source',
        token_in_symbol: 'USDC',
        token_out_symbol: 'ETH',
        amount_in: '1',
        amount_out: '1',
        amount_in_usd: null,
        gas_used: null,
        gas_savings_usd: null,
        is_gasless: false,
        tx_hash: null,
      },
    ])
    // Quoted because of the comma in the source name.
    expect(csv).toMatch(/"evil,source"/)
  })
})
