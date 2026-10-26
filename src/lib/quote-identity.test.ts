import { describe, it, expect } from 'vitest'
import { makeQuoteKey, parseQuoteEcho, quoteMatchesSelection, sameQuoteKey, sameQuotePair } from './quote-identity'

const A = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const B = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const key = makeQuoteKey({ chainId: 1, tokenIn: A, tokenOut: B, amountRaw: '1000', decimalsIn: 18, decimalsOut: 6 })

describe('quote-identity', () => {
  it('lowercases addresses when building a key', () => {
    expect(key.tokenIn).toBe(A.toLowerCase())
    expect(key.tokenOut).toBe(B.toLowerCase())
  })

  it('sameQuotePair ignores the amount and address case; the flipped pair, another chain or other decimals do not match', () => {
    const otherAmount = { ...key, amountRaw: '9' }
    expect(sameQuotePair(key, otherAmount)).toBe(true)
    const upper = { ...key, tokenIn: A.toUpperCase().replace('0X', '0x') }
    expect(sameQuotePair(key, upper)).toBe(true)
    expect(sameQuotePair(key, { ...key, tokenIn: key.tokenOut, tokenOut: key.tokenIn, decimalsIn: 6, decimalsOut: 18 })).toBe(false)
    expect(sameQuotePair(key, { ...key, chainId: 8453 })).toBe(false)
    expect(sameQuotePair(key, { ...key, decimalsOut: 18 })).toBe(false)
  })

  it('sameQuoteKey additionally requires the same raw amount', () => {
    expect(sameQuoteKey(key, { ...key })).toBe(true)
    expect(sameQuoteKey(key, { ...key, amountRaw: '1001' })).toBe(false)
  })

  it('quoteMatchesSelection fails closed on missing identity or missing tokens', () => {
    const sel = { chainId: 1, tokenIn: { address: A, decimals: 18 }, tokenOut: { address: B, decimals: 6 } }
    expect(quoteMatchesSelection({ ...key, fetchedAt: 1 }, sel)).toBe(true)
    expect(quoteMatchesSelection(undefined, sel)).toBe(false)
    expect(quoteMatchesSelection(null, sel)).toBe(false)
    expect(quoteMatchesSelection({ ...key, fetchedAt: 1 }, { ...sel, tokenOut: null })).toBe(false)
    expect(quoteMatchesSelection({ ...key, fetchedAt: 1 }, { ...sel, tokenIn: sel.tokenOut, tokenOut: sel.tokenIn })).toBe(false)
  })

  describe('parseQuoteEcho', () => {
    const echo = { tokenIn: A, tokenOut: B, chainId: 1, decimalsIn: 18, decimalsOut: 6, amountIn: '1000' }
    it('builds the key from a well-formed echo', () => {
      expect(parseQuoteEcho(echo)).toEqual(key)
    })
    it.each([
      ['null', null],
      ['a string', 'x'],
      ['missing tokenIn', { ...echo, tokenIn: undefined }],
      ['non-integer chainId', { ...echo, chainId: 1.5 }],
      ['chainId 0', { ...echo, chainId: 0 }],
      ['NaN decimals (JSON null)', { ...echo, decimalsOut: null }],
      ['negative decimals', { ...echo, decimalsIn: -1 }],
      ['decimals > 255', { ...echo, decimalsIn: 256 }],
      ['non-numeric amountIn', { ...echo, amountIn: '1e18' }],
      ['numeric (not string) amountIn', { ...echo, amountIn: 1000 }],
    ])('rejects %s', (_label, bad) => {
      expect(parseQuoteEcho(bad)).toBeNull()
    })
  })
})
