/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Source normalizers — pure parsers over fetched JSON.
 * Malformed entries are SKIPPED (never crash the build); addresses are EIP-55 checksummed.
 */
import { describe, it, expect } from 'vitest'
import { parseTokenList, parseOneInchMap, parseDefiLlamaCoins } from './sources'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

describe('parseTokenList — standard tokenlist shape (uniswap/coingecko/superchain/trustwallet)', () => {
  it('normalizes valid entries for the requested chain, checksumming addresses', () => {
    const raw = {
      tokens: [
        { chainId: 1, address: WETH.toLowerCase(), symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: 'x' },
        { chainId: 8453, address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'WETH', decimals: 18 },
      ],
    }
    const entries = parseTokenList(raw, 1, 'uniswap')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ chainId: 1, address: WETH, symbol: 'WETH', decimals: 18, source: 'uniswap' })
  })

  it('skips malformed entries: bad address, non-integer/out-of-range decimals, missing symbol', () => {
    const raw = {
      tokens: [
        { chainId: 1, address: '0xnothex', symbol: 'BAD', name: 'Bad', decimals: 18 },
        { chainId: 1, address: WETH, symbol: 'WETH', name: 'W', decimals: 18.5 },
        { chainId: 1, address: WETH, symbol: 'WETH', name: 'W', decimals: 42 },
        { chainId: 1, address: WETH, symbol: '', name: 'W', decimals: 18 },
        { chainId: 1, address: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
      ],
    }
    const entries = parseTokenList(raw, 1, 'uniswap')
    expect(entries).toHaveLength(1)
    expect(entries[0].symbol).toBe('WETH')
  })

  it('tolerates a completely alien payload (returns [])', () => {
    expect(parseTokenList(null, 1, 'uniswap')).toEqual([])
    expect(parseTokenList({ nope: true }, 1, 'uniswap')).toEqual([])
    expect(parseTokenList('garbage', 1, 'uniswap')).toEqual([])
  })

  it('falls back to symbol when name is missing', () => {
    const raw = { tokens: [{ chainId: 1, address: WETH, symbol: 'WETH', decimals: 18 }] }
    expect(parseTokenList(raw, 1, 'uniswap')[0].name).toBe('WETH')
  })
})

describe('parseOneInchMap — 1inch address-keyed map shape', () => {
  it('normalizes the {address: {…}} map for the chain', () => {
    const raw = {
      [WETH.toLowerCase()]: { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, address: WETH.toLowerCase(), logoURI: 'y' },
    }
    const entries = parseOneInchMap(raw, 1)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ chainId: 1, address: WETH, symbol: 'WETH', source: 'oneinch' })
  })

  it('skips malformed values and alien payloads', () => {
    expect(parseOneInchMap(null, 1)).toEqual([])
    expect(parseOneInchMap({ '0xbad': { symbol: 'X' } }, 1)).toEqual([])
  })
})

describe('parseDefiLlamaCoins — identity votes + market signals', () => {
  it('produces an identity entry and a market signal per resolved coin', () => {
    const raw = {
      coins: {
        [`ethereum:${WETH.toLowerCase()}`]: { price: 3500.12, symbol: 'WETH', decimals: 18, confidence: 0.99 },
      },
    }
    const { entries, market } = parseDefiLlamaCoins(raw, 1, 'ethereum')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ chainId: 1, address: WETH, symbol: 'WETH', decimals: 18, source: 'defillama' })
    const sig = market.get(`1:${WETH.toLowerCase()}`)
    expect(sig).toMatchObject({ priceUsd: 3500.12, priceConfidence: 0.99 })
  })

  it('a price WITHOUT symbol+decimals yields a market signal but NO identity vote', () => {
    const raw = { coins: { [`ethereum:${WETH.toLowerCase()}`]: { price: 1.0, confidence: 0.95 } } }
    const { entries, market } = parseDefiLlamaCoins(raw, 1, 'ethereum')
    expect(entries).toHaveLength(0)
    expect(market.size).toBe(1)
  })

  it('tolerates alien payloads', () => {
    expect(parseDefiLlamaCoins(null, 1, 'ethereum').entries).toEqual([])
    expect(parseDefiLlamaCoins({ coins: 'x' }, 1, 'ethereum').entries).toEqual([])
  })
})
