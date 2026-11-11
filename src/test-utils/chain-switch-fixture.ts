/**
 * [fix/chain-switch-token-fallback] Shared fixture for the chain-switch guard tests (v1 SwapBox + v2 SwapCard).
 *
 * Six tokens — each a real catalog entry on ONE chain (so on every other chain it is a foreign address), plus an
 * import scoped to Base — and the chain-switch walks the guards replay.
 */
import { addCustomToken, findToken, removeCustomToken, type Token } from '@/lib/tokens'
import { findChainToken, getFullCatalog } from '@/lib/chains/tokens'

export const CHAINS: readonly number[] = [1, 8453, 42161]

const IMPORTED_ON_BASE = '0x1234567890123456789012345678901234567890'

export function importFixtureToken(): void {
  addCustomToken({ address: IMPORTED_ON_BASE, symbol: 'IMPBASE', name: 'Imported on Base', decimals: 18, logoURI: '', category: 'Imported', chainId: 8453 })
}
export function removeFixtureToken(): void {
  removeCustomToken(IMPORTED_ON_BASE, 8453)
}

/** ETH, mainnet SNX / USDC, Base SNX (0x22e6…), Arbitrum USDC (0xaf88…), and a token imported on Base. Call after importFixtureToken(). */
export function fixtureTokens(): Token[] {
  const pick = (address: string, chainId: number) => {
    const t = findChainToken(address, chainId)
    if (!t) throw new Error(`fixture token ${address} missing on chain ${chainId}`)
    return t
  }
  return [
    findToken('ETH') as Token,
    findToken('SNX') as Token,
    findToken('USDC') as Token,
    pick('0x22e6966B799c4D5B13BE962E1D117b56327FDa66', 8453),
    pick('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 42161),
    pick(IMPORTED_ON_BASE, 8453),
  ]
}

/** Ordered pairs of distinct fixture tokens (30). */
export function fixturePairs(tokens: Token[]): Array<[Token, Token]> {
  const out: Array<[Token, Token]> = []
  for (const a of tokens) for (const b of tokens) if (a.address.toLowerCase() !== b.address.toLowerCase()) out.push([a, b])
  return out
}

/** Every walk of two chain switches from `start` (never "switching" to the chain you are on): start→x→y. Plus the 1-switch prefixes. */
export function chainWalks(start: number): number[][] {
  const walks: number[][] = []
  for (const x of CHAINS) {
    if (x === start) continue
    walks.push([x])
    for (const y of CHAINS) if (y !== x) walks.push([x, y])
  }
  return walks
}

/** Is `address` in the chain's pinned catalog (verified — no ⚠), as opposed to an import? */
export const inCatalog = (address: string, chainId: number): boolean =>
  getFullCatalog(chainId).some((t) => t.address.toLowerCase() === address.toLowerCase())
/** catalog ∪ imported-for-that-chain. */
export const knownOnChain = (address: string, chainId: number): boolean => findChainToken(address, chainId) !== null
