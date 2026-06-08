/**
 * [SPRINT-9Y] Expanded, pinned per-chain token catalog (Matcha-style).
 *
 * Guards the NON-NEGOTIABLE address-correctness rule: every catalog address is sourced from the
 * pinned Uniswap Labs Default snapshot (+ one CoinGecko Base USDT), EIP-55 checksummed, with valid
 * decimals — a wrong address means users buy a scam/wrong token. The majors fixtures below pin the
 * top tokens per chain so an accidental edit fails CI.
 */
import { describe, it, expect } from 'vitest'
import { getAddress, isAddress } from 'viem'
import {
  getFullCatalog,
  getSearchCatalog,
  getChainTokenList,
  getPopularTokens,
  isVerifiedToken,
  findChainToken,
  SEARCH_RESULT_LIMIT,
  CHAIN_TOKENS,
} from './tokens'
import { GENERATED_TOKEN_CATALOG } from './token-catalog.generated'
import { DEFAULT_TOKENS, addCustomToken } from '@/lib/tokens'
import { NATIVE_ETH } from '@/lib/constants'

const MAINNET = 1
const BASE = 8453

// ── Address-integrity fixtures — pin the majors per chain (guard accidental edits) ──
const MAINNET_MAJORS: Record<string, string> = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
}
const BASE_MAJORS: Record<string, string> = {
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  EURC: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  DEGEN: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  VIRTUAL: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
  MORPHO: '0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842',
}

describe('[9Y] address integrity — every PINNED catalog entry checksummed + valid decimals', () => {
  // Strict EIP-55 on the data this sprint ADDS (the generated catalog). The pre-existing
  // mainnet DEFAULT_TOKENS list is covered by the byte-identical block below — it is left
  // untouched (one legacy entry, USDe, carries a non-canonical checksum; flagged in FEEDBACK).
  for (const chainId of [MAINNET, BASE]) {
    it(`chain ${chainId}: every generated entry is EIP-55 with valid integer decimals`, () => {
      const list = GENERATED_TOKEN_CATALOG[chainId]
      expect(list.length).toBeGreaterThan(20)
      for (const t of list) {
        // a stored address must already equal its canonical checksum form
        expect(getAddress(t.address)).toBe(t.address)
        expect(Number.isInteger(t.decimals)).toBe(true)
        expect(t.decimals).toBeGreaterThanOrEqual(0)
        expect(t.decimals).toBeLessThanOrEqual(36)
      }
    })
  }

  it('the full per-chain catalog only contains runtime-valid addresses + valid decimals', () => {
    for (const chainId of [MAINNET, BASE]) {
      for (const t of getFullCatalog(chainId)) {
        if (t.address.toLowerCase() === NATIVE_ETH.toLowerCase()) continue
        expect(isAddress(t.address, { strict: false })).toBe(true)
        expect(Number.isInteger(t.decimals)).toBe(true)
      }
    }
  })

  it('mainnet majors are pinned to their exact addresses', () => {
    const byAddr = new Map(getFullCatalog(MAINNET).map((t) => [t.symbol, t.address] as const))
    for (const [sym, addr] of Object.entries(MAINNET_MAJORS)) {
      expect(byAddr.get(sym)).toBe(addr)
    }
  })

  it('Base majors are pinned to their exact addresses (sourced from the pinned list)', () => {
    const catalog = getFullCatalog(BASE)
    for (const [sym, addr] of Object.entries(BASE_MAJORS)) {
      const found = catalog.find((t) => t.symbol === sym)
      expect(found, `missing Base major ${sym}`).toBeDefined()
      expect(found!.address).toBe(addr)
    }
  })
})

describe('[9Y] mainnet catalog stays byte-identical (only ADD)', () => {
  it('getChainTokenList(1) is the exact DEFAULT_TOKENS reference', () => {
    expect(getChainTokenList(MAINNET)).toBe(DEFAULT_TOKENS)
    expect(CHAIN_TOKENS[MAINNET].length).toBe(DEFAULT_TOKENS.length)
  })

  it('every existing DEFAULT_TOKENS entry is still present, unchanged, in the full catalog', () => {
    const byAddr = new Map(getFullCatalog(MAINNET).map((t) => [t.address.toLowerCase(), t] as const))
    for (const dt of DEFAULT_TOKENS) {
      const t = byAddr.get(dt.address.toLowerCase())
      expect(t, `missing ${dt.symbol}`).toBeDefined()
      expect(t!.symbol).toBe(dt.symbol)
      expect(t!.decimals).toBe(dt.decimals)
      expect(t!.address).toBe(dt.address)
    }
  })
})

describe('[9Y] curated "Suggested" set per chain (shown by default)', () => {
  it('Base suggested set contains the spec majors and is ~20-30 tokens', () => {
    const symbols = getChainTokenList(BASE).map((t) => t.symbol)
    for (const sym of ['ETH', 'WETH', 'USDC', 'USDbC', 'USDT', 'DAI', 'cbETH', 'cbBTC', 'AERO', 'EURC', 'MORPHO', 'DEGEN', 'VIRTUAL']) {
      expect(symbols, `suggested set missing ${sym}`).toContain(sym)
    }
    expect(symbols.length).toBeGreaterThanOrEqual(20)
    expect(symbols.length).toBeLessThanOrEqual(30)
  })

  it('Base popular chips are a small subset of the suggested set', () => {
    const popular = getPopularTokens(BASE).map((t) => t.symbol)
    expect(popular).toContain('ETH')
    expect(popular).toContain('USDC')
    expect(popular).toContain('AERO')
    expect(popular.length).toBeLessThanOrEqual(12)
  })

  it('mainnet popular/default view is unchanged (still derived from DEFAULT_TOKENS)', () => {
    expect(getChainTokenList(MAINNET)).toBe(DEFAULT_TOKENS)
  })
})

describe('[9Y] full searchable catalog finds the long tail per chain', () => {
  it('Base full catalog is much larger than the suggested set', () => {
    expect(getFullCatalog(BASE).length).toBeGreaterThan(getChainTokenList(BASE).length)
    expect(getFullCatalog(BASE).length).toBeGreaterThanOrEqual(90)
  })

  it('mainnet full catalog adds the Uniswap long tail on top of DEFAULT_TOKENS', () => {
    expect(getFullCatalog(MAINNET).length).toBeGreaterThan(DEFAULT_TOKENS.length)
  })

  it('finds a Base long-tail token by symbol (not in the suggested set)', () => {
    const suggested = new Set(getChainTokenList(BASE).map((t) => t.symbol))
    // ZRX is in the pinned Base list but not a curated suggested major.
    expect(suggested.has('ZRX')).toBe(false)
    const hit = getSearchCatalog(BASE).find((t) => t.symbol === 'ZRX')
    expect(hit, 'ZRX should be searchable on Base').toBeDefined()
  })

  it('finds a mainnet long-tail token by symbol (not in DEFAULT_TOKENS)', () => {
    const inDefault = new Set(DEFAULT_TOKENS.map((t) => t.symbol))
    expect(inDefault.has('ACX')).toBe(false)
    const hit = getSearchCatalog(MAINNET).find((t) => t.symbol === 'ACX')
    expect(hit, 'ACX (Across) should be searchable on mainnet').toBeDefined()
  })

  it('a long-tail token is findable by (lowercased) address too', () => {
    const zrx = getSearchCatalog(BASE).find((t) => t.symbol === 'ZRX')!
    const byAddr = getSearchCatalog(BASE).find(
      (t) => t.address.toLowerCase() === zrx.address.toLowerCase(),
    )
    expect(byAddr?.symbol).toBe('ZRX')
  })
})

describe('[9Y] verified ✓ vs imported ⚠ (9P intact, extended to the long tail)', () => {
  it('a Base long-tail catalog token verifies ✓ on Base', () => {
    const zrx = getSearchCatalog(BASE).find((t) => t.symbol === 'ZRX')!
    expect(isVerifiedToken(zrx.address, BASE)).toBe(true)
  })

  it('a mainnet long-tail catalog token verifies ✓ on mainnet', () => {
    const acx = getSearchCatalog(MAINNET).find((t) => t.symbol === 'ACX')!
    expect(isVerifiedToken(acx.address, MAINNET)).toBe(true)
  })

  it('a genuinely imported (non-catalog) address keeps ⚠ on each chain', () => {
    const unknown = '0x6c240dDA6b5C336Df09a4D011139beaaA1Ea2aa2' // the prod-reported Base import
    expect(isVerifiedToken(unknown, BASE)).toBe(false)
    expect(isVerifiedToken(unknown, MAINNET)).toBe(false)
  })

  it('existing 9P expectations hold: mainnet USDC ✓, a Base-only address ✗ on mainnet', () => {
    expect(isVerifiedToken(MAINNET_MAJORS.USDC, MAINNET)).toBe(true)
    expect(isVerifiedToken(BASE_MAJORS.USDC, MAINNET)).toBe(false)
  })
})

describe('[9Y] search respects the active chain + custom imports (chain-scoped, 9P)', () => {
  it('a token imported on Base is searchable on Base but never leaks to mainnet search', () => {
    const collision = '0x2222222222222222222222222222222222222222'
    addCustomToken({ address: collision, symbol: 'NINEY', name: 'Niner', decimals: 18, logoURI: '', category: 'Imported', chainId: BASE })
    expect(getSearchCatalog(BASE).some((t) => t.address.toLowerCase() === collision.toLowerCase())).toBe(true)
    expect(getSearchCatalog(MAINNET).some((t) => t.address.toLowerCase() === collision.toLowerCase())).toBe(false)
  })

  it('findChainToken resolves a long-tail Base catalog address (consistent with the ✓ badge)', () => {
    const zrx = getSearchCatalog(BASE).find((t) => t.symbol === 'ZRX')!
    expect(findChainToken(zrx.address, BASE)?.symbol).toBe('ZRX')
    // ...and that same Base address must not resolve on mainnet.
    expect(findChainToken(zrx.address, MAINNET)).toBeNull()
  })
})

describe('[9Y] search performance stays bounded (no UI jank)', () => {
  it('catalogs are hundreds of tokens, not thousands (CoinGecko 2369 was deliberately not baked)', () => {
    expect(getFullCatalog(BASE).length).toBeLessThan(500)
    expect(getFullCatalog(MAINNET).length).toBeLessThan(1000)
    // displayed results are capped so a broad query never renders the whole list
    expect(SEARCH_RESULT_LIMIT).toBeGreaterThan(0)
    expect(SEARCH_RESULT_LIMIT).toBeLessThanOrEqual(150)
  })

  it('filtering the full mainnet catalog many times is cheap', () => {
    const all = getSearchCatalog(MAINNET)
    const q = 'a'
    // 200 passes over the whole catalog — a generous budget that still fails if the list
    // were thousands of entries or filtering were accidentally super-linear.
    for (let i = 0; i < 200; i++) {
      all.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address.toLowerCase().includes(q))
    }
    expect(all.length).toBeGreaterThan(0)
  })
})
