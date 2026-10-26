// @vitest-environment jsdom
/**
 * [fix/imported-tokens-persist] Storage layer: versioned per-chain key, exact schema, and
 * "storage can never crash the app" (corrupt JSON, hostile shapes, throwing localStorage).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  importedTokensKey,
  loadImportedTokens,
  removeImportedToken,
  saveImportedToken,
} from './imported-tokens'

// Synthetic addresses — never real tokens.
const A = '0x00000000000000000000000000000000000000a1' as const
const B = '0x00000000000000000000000000000000000000b2' as const

const rec = (address: `0x${string}`, over: Record<string, unknown> = {}) => ({
  address,
  symbol: 'TST',
  name: 'Test Token',
  decimals: 18,
  importedAt: 1_700_000_000_000,
  ...over,
})

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('imported-tokens storage', () => {
  it('uses a versioned per-chain key', () => {
    expect(importedTokensKey(8453)).toBe('ts:imported-tokens:v1:8453')
    expect(importedTokensKey(1)).toBe('ts:imported-tokens:v1:1')
  })

  it('persists exactly {address, symbol, name, decimals, importedAt} — nothing else', () => {
    saveImportedToken(8453, { address: A, symbol: 'TST', name: 'Test Token', decimals: 6, importedAt: 42 })
    const stored = JSON.parse(localStorage.getItem('ts:imported-tokens:v1:8453')!)
    expect(stored).toHaveLength(1)
    expect(Object.keys(stored[0]).sort()).toEqual(['address', 'decimals', 'importedAt', 'name', 'symbol'])
    expect(stored[0]).toMatchObject({ symbol: 'TST', name: 'Test Token', decimals: 6, importedAt: 42 })
    // EIP-55 checksummed on the way in
    expect(stored[0].address.toLowerCase()).toBe(A)
  })

  it('stamps importedAt when absent and keeps the ORIGINAL on a re-save', () => {
    saveImportedToken(8453, { address: A, symbol: 'TST', name: 'Test Token', decimals: 18 })
    const first = loadImportedTokens(8453)[0].importedAt
    expect(first).toBeGreaterThan(0)
    saveImportedToken(8453, { address: A, symbol: 'TST2', name: 'Test Token', decimals: 18, importedAt: first + 999 })
    const after = loadImportedTokens(8453)
    expect(after).toHaveLength(1)
    expect(after[0].importedAt).toBe(first)
    expect(after[0].symbol).toBe('TST2')
  })

  it('is chain-scoped: one chain never reads another chain\'s key', () => {
    saveImportedToken(8453, { address: A, symbol: 'TST', name: 'Test Token', decimals: 18 })
    expect(loadImportedTokens(8453)).toHaveLength(1)
    expect(loadImportedTokens(1)).toEqual([])
    expect(loadImportedTokens(42161)).toEqual([])
  })

  it('remove deletes only the named token, and the key once empty', () => {
    saveImportedToken(8453, { address: A, symbol: 'AAA', name: 'A', decimals: 18 })
    saveImportedToken(8453, { address: B, symbol: 'BBB', name: 'B', decimals: 18 })
    removeImportedToken(8453, A.toUpperCase().replace('0X', '0x'))
    expect(loadImportedTokens(8453).map((t) => t.symbol)).toEqual(['BBB'])
    removeImportedToken(8453, B)
    expect(localStorage.getItem('ts:imported-tokens:v1:8453')).toBeNull()
  })

  it.each([
    ['not JSON', '{nope'],
    ['JSON but not an array', '{"address":"x"}'],
    ['null', 'null'],
    ['array of junk', '[1,"a",null,{}]'],
  ])('corrupt storage (%s) is ignored without throwing', (_label, raw) => {
    localStorage.setItem('ts:imported-tokens:v1:8453', raw)
    expect(() => loadImportedTokens(8453)).not.toThrow()
    expect(loadImportedTokens(8453)).toEqual([])
  })

  it('skips malformed records but keeps the valid ones next to them', () => {
    localStorage.setItem(
      'ts:imported-tokens:v1:8453',
      JSON.stringify([
        rec(A),
        rec('0xnot-an-address' as `0x${string}`),
        rec(B, { decimals: -1 }),
        rec(B, { decimals: 1.5 }),
        rec(B, { symbol: '' }),
        rec(B, { symbol: '<img src=x>' }),
        rec(B, { name: 'N'.repeat(65) }),
        rec(B, { importedAt: 'yesterday' }),
      ]),
    )
    expect(loadImportedTokens(8453).map((t) => t.address.toLowerCase())).toEqual([A])
  })

  it('collapses duplicate addresses (case-insensitive)', () => {
    localStorage.setItem(
      'ts:imported-tokens:v1:8453',
      JSON.stringify([rec(A), rec(A.toUpperCase().replace('0X', '0x') as `0x${string}`)]),
    )
    expect(loadImportedTokens(8453)).toHaveLength(1)
  })

  it('a throwing localStorage (private mode / blocked) never crashes load, save or remove', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(loadImportedTokens(8453)).toEqual([])
    expect(() => saveImportedToken(8453, { address: A, symbol: 'TST', name: 'T', decimals: 18 })).not.toThrow()
    expect(() => removeImportedToken(8453, A)).not.toThrow()
  })
})
