/**
 * [fix/limit-sltp-chain-aware-price-feed — NARROWED] PINS the exact set of real-catalog tokens
 * that resolve to a signable `order.priceFeed`, per chain, through the ONE resolver both order
 * panels use (`resolveOrderPriceFeed`).
 *
 * WHY A PIN: the first cut of this branch (29d9519) fixed the H2 chain-awareness bug and, as a
 * SIDE EFFECT nobody noticed, widened the mainnet signable set from 7 symbols to 26 — one of the
 * 19 additions had ZERO on-chain code. A green suite proved nothing because no test described the
 * set. This file does: widening (or shrinking, or re-pointing) the signable set on ANY chain now
 * BREAKS a test, so it becomes a deliberate act — a rule-#9 PR that edits this pin alongside an
 * on-chain verification — instead of a refactor's shadow.
 *
 * The expected maps are LITERALS on purpose. Every other test on this branch reads its expected
 * address from the helper under test so it cannot drift; a pin must be the opposite — a fixed
 * point outside the code — or it pins nothing. They were generated from the resolver's own output
 * over the real catalogs at this commit (never hand-typed), lowercased, and compared lowercased:
 * this pins IDENTITY, not checksum casing.
 *
 * NOT a denylist. No address is refused by name anywhere in production code. The mainnet proof
 * below is structural: every mainnet answer is one of the 7 symbol-table addresses, so nothing the
 * address-keyed map holds — dead or alive — can reach a signature.
 */
import { describe, it, expect } from 'vitest'
import { resolveOrderPriceFeed } from './price-feed'
import { getChainlinkFeeds } from './config'
import { getChainTokenList } from '../chains/tokens'
import { CHAINLINK_FEEDS } from '../constants'

/** symbol → feed (lowercased) for every catalog token on `chainId` that resolves at all. */
function signableBySymbol(chainId: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of getChainTokenList(chainId)) {
    const feed = resolveOrderPriceFeed(t, chainId)
    if (feed) out[t.symbol] = feed.toLowerCase()
  }
  return out
}

/** How many catalog TOKENS (not symbols) resolve — a duplicate-symbol imposter would change this. */
function signableTokenCount(chainId: number): number {
  return getChainTokenList(chainId).filter(t => resolveOrderPriceFeed(t, chainId) !== '').length
}

// ── The pins ─────────────────────────────────────────────────────────────────────────────────
// origin/main mainnet behaviour: the 7-entry SYMBOL table (config.ts MAINNET_FEEDS) + the #490
// wrapped-native fallback (WETH → ETH/USD). BTC/USD is in the table but no catalog token is
// symbol 'BTC' (WBTC is not), so 6 table hits + WETH = 7 signable symbols, 7 signable tokens.
const MAINNET_SIGNABLE: Record<string, string> = {
  AAVE: '0x547a514d5e3769680ce22b2361c10ea13619e8a9',
  DAI: '0xaed0c38402a5d19df6e4c03f4e2dced6e29c1ee9',
  ETH: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
  LINK: '0x2c1d072e956affc0d435cb7ac38ef18d24d9127c',
  UNI: '0x553303d460ee0afb37edff9be42922d8ff63220e',
  USDC: '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6',
  WETH: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
}
// [FEAT-DCA-FEED-REGISTRATION-PHASE1] Re-pinned 2026-10-11 from the resolver's own output: Base USDC is now the
// plain usdc-usd proxy, and the enabled phase-1 registration rows widen the set (deliberate, owner-approved).
// Base: CHAINLINK_FEEDS_BY_CHAIN[8453] (address-keyed entries; native sentinel → WETH's).
// Each verified on Base itself for this commit: eth_getCode 9571 bytes, description() names the
// pair, decimals() 8, latestRoundData() fresh and > 0, on two independent RPCs.
const BASE_SIGNABLE: Record<string, string> = {
  COMP: '0x9dda783de64a9d1a60c49ca761ebe528c35ba428',
  DAI: '0x591e79239a7d679378ec8c847e5038150364c78f',
  ETH: '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70',
  EURC: '0xdae398520e2b67cd3f27aef9cf14d93d927f8250',
  USDC: '0x7e860098f58bbfc8648a4311b374b1d669a2bc6b',
  USDT: '0xf19d560eb8d2adf07bd6d13ed03e1d11215721f9',
  VIRTUAL: '0xeaf310161c9ef7c813a14f8fef6fb271434019f7',
  WETH: '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70',
  cbBTC: '0x07da0e54543a844a80abe69c8a12f22b3aa59f9d',
}
// Arbitrum: CHAINLINK_FEEDS_BY_CHAIN[42161] (5 entries; same per-address verification on Arbitrum).
const ARBITRUM_SIGNABLE: Record<string, string> = {
  AAVE: '0xad1d5344aade45f43e596773bcc4c423eabdd034',
  ARB: '0xb2a824043730fe05f3da2efafa1cbbe83fa548d6',
  COMP: '0xe7c53ffd03eb6cef7d208bc4c13446c76d1e5884',
  CRV: '0xaebda2c976cfd1ee1977eac079b4382acb849325',
  DAI: '0xc5c8e77b397e531b8ec06bfb0048328b30e9ecfb',
  ETH: '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612',
  LDO: '0xa43a34030088e6510feccfb77e88ee5e7ed0fe64',
  LINK: '0x86e53cf1b870786351da77a57575e79cb55812cb',
  MAGIC: '0x47e55ccec6582838e173f252d08afd8116c2202d',
  PENDLE: '0x66853e19d73c0f9301fe099c324a1e9726953433',
  SUSHI: '0xb2a8ba74cbca38508ba1632761b56c897060147c',
  UNI: '0x9c917083fdb403ab5adbec26ee294f6ecada2720',
  USDC: '0x50834f3163758fcc1df9973b6e91f0f0f0434ad3',
  USDT: '0x3f3f5df88dc9f13eac63df89ec16ef6e7e25dde7',
  WBTC: '0xd0c7101eacbb49f3decccc166d238410d6d46d57',
  WETH: '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612',
}

describe('resolveOrderPriceFeed — the signable feed set is PINNED per chain', () => {
  it('MAINNET: exactly these 7 catalog symbols resolve, to exactly these feeds — identical to origin/main', () => {
    expect(signableBySymbol(1)).toEqual(MAINNET_SIGNABLE)
    expect(signableTokenCount(1)).toBe(Object.keys(MAINNET_SIGNABLE).length)
  })

  it('MAINNET: the symbol table itself is exactly the 7 origin/main entries', () => {
    expect(Object.keys(getChainlinkFeeds(1)).sort()).toEqual(
      ['AAVE/USD', 'BTC/USD', 'DAI/USD', 'ETH/USD', 'LINK/USD', 'UNI/USD', 'USDC/USD'],
    )
  })

  it('MAINNET: every answer is a symbol-table address — the address-keyed CHAINLINK_FEEDS map is unreachable from a signature', () => {
    const tableAddrs = new Set(Object.values(getChainlinkFeeds(1)).map(f => f.address.toLowerCase()))
    expect(tableAddrs.size).toBe(7)

    // (a) Over the real catalog: nothing resolves to an address outside the table.
    for (const t of getChainTokenList(1)) {
      const feed = resolveOrderPriceFeed(t, 1).toLowerCase()
      if (feed) expect(tableAddrs.has(feed), `${t.symbol} signed a non-table feed ${feed}`).toBe(true)
    }

    // (b) Over the ENTIRE address-keyed map the swap read path uses: for every token address it
    //     knows, the resolver either refuses or answers from the table — never with the map's own
    //     entry unless that entry is ALSO a table address. Not vacuous: the map holds entries the
    //     table does not (the widening of 29d9519 was exactly those).
    const bySymbol = new Map(getChainTokenList(1).map(t => [t.address.toLowerCase(), t.symbol]))
    let mapOnly = 0
    for (const [tokenAddr, mapFeed] of Object.entries(CHAINLINK_FEEDS)) {
      const feedLc = mapFeed.toLowerCase()
      const token = { address: tokenAddr as `0x${string}`, symbol: bySymbol.get(tokenAddr) ?? `?${tokenAddr.slice(0, 8)}` }
      const answer = resolveOrderPriceFeed(token, 1).toLowerCase()
      expect(answer === '' || tableAddrs.has(answer), `${token.symbol} → ${answer}`).toBe(true)
      if (!tableAddrs.has(feedLc)) {
        mapOnly++
        expect(answer, `${token.symbol}: the map-only feed ${feedLc} leaked into a signature`).not.toBe(feedLc)
      }
    }
    expect(mapOnly).toBeGreaterThan(0)
  })

  it('MAINNET witness: the token 29d9519 made signable against a dead proxy resolves NOTHING again', () => {
    // A witness for the finding that produced this narrowing, NOT a denylist: the address is read
    // from the map, never typed, and nothing in production refuses it by name — (b) above is what
    // keeps it out. The read path already fails it closed (ADR-018); the signing path never sees it.
    const pepe = getChainTokenList(1).find(t => t.symbol === 'PEPE')
    expect(pepe).toBeDefined()
    const mapWouldHaveAnswered = CHAINLINK_FEEDS[pepe!.address.toLowerCase()]
    expect(mapWouldHaveAnswered).toBeDefined()
    expect(resolveOrderPriceFeed(pepe!, 1)).toBe('')
  })

  it('BASE: exactly these catalog symbols resolve, to Base feeds — never a mainnet aggregator [H2]', () => {
    expect(signableBySymbol(8453)).toEqual(BASE_SIGNABLE)
    expect(signableTokenCount(8453)).toBe(Object.keys(BASE_SIGNABLE).length)
    const mainnetAddrs = new Set(Object.values(getChainlinkFeeds(1)).map(f => f.address.toLowerCase()))
    for (const feed of Object.values(BASE_SIGNABLE)) expect(mainnetAddrs.has(feed)).toBe(false)
  })

  it('ARBITRUM: exactly these catalog symbols resolve, to Arbitrum feeds — never a mainnet aggregator', () => {
    expect(signableBySymbol(42161)).toEqual(ARBITRUM_SIGNABLE)
    expect(signableTokenCount(42161)).toBe(Object.keys(ARBITRUM_SIGNABLE).length)
    const mainnetAddrs = new Set(Object.values(getChainlinkFeeds(1)).map(f => f.address.toLowerCase()))
    for (const feed of Object.values(ARBITRUM_SIGNABLE)) expect(mainnetAddrs.has(feed)).toBe(false)
  })

  it('an UNCOVERED chain resolves nothing for any mainnet-catalog token — fail-closed, never a sibling\'s feed', () => {
    for (const t of getChainTokenList(1)) expect(resolveOrderPriceFeed(t, 10)).toBe('')
  })
})
