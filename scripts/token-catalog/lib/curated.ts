/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Curated corrections — PORTED from
 * scripts/generate-token-catalog.mjs (CHORE-CATALOG-CLEANUP / CHORE-CATALOG-COLLISIONS-
 * DECIMALS) so audit-driven dispositions survive the move to multi-source discovery.
 * Every entry was VERIFIED on-chain + against authoritative sources in those chores; see
 * their FEEDBACK sections for the per-token disposition. Keyed by `chainId:loweraddress`.
 *
 * Applied to EVERY source's normalized entries BEFORE merging, so a stale upstream list
 * cannot resurrect a removed token or out-vote a corrected address/decimals.
 */
import type { SeedToken, SourceEntry } from './types'

// REMOVALS — drop the entry entirely (canonical is dead/non-routable, or already present):
const REMOVALS = new Set([
  '1:0xa4e8c3ec456107ea67d3075bf9e3df3a75823db0', // LOOM — migrated; successor DEX-dead → non-routable, remove.
  '1:0x36e66fbbce51e4cd5bd3c62b637eb411b18949d4', // OMNI — rebranded/redenominated to NOM; successor non-routable → remove.
  '1:0x1985365e9f78359a9b6ad760e32412f4a445e862', // REP — deprecated v1; REPv2 is a separate entry → remove (would duplicate).
  '1:0xb59490ab09a0f526cc7305822ac65f2ab12f9723', // LIT — Litentry (deprecated → Heima); Lighter holds the canonical "LIT".
])

// REMAPS — replace a deprecated address with the verified canonical token (full metadata):
const REMAPS: Record<string, Omit<SourceEntry, 'source'>> = {
  // LCX V1 "Old Contract" → LCX Token 2.0 (1:1 upgrade; CoinGecko/CMC moved; active liquidity).
  '1:0x037a54aab062628c9bbae1fdb1583c195585fe41': {
    chainId: 1, address: '0x8cD41041505885Ef0aD3858181d66F17be8aAE7E' as `0x${string}`, symbol: 'LCX', name: 'LCX', decimals: 18,
  },
  // Rubic "Old RBC Token" (NON-TRANSFERABLE on-chain) → migrated 1:1 RUBIC TOKEN (transferable).
  '1:0xa4eed63db85311e22df4473f87ccfc3dadcfa3e3': {
    chainId: 1, address: '0x3330BFb7332cA23cd071631837dC289B09C33333' as `0x${string}`, symbol: 'RBC', name: 'Rubic', decimals: 18,
  },
  // AVT ticker collision: dead "ArtVerse Token" → Aventus (CoinGecko-canonical). OWNER-SIGNED-OFF.
  '1:0x845576c64f9754cf09d87e45b720e82f3eef522c': {
    chainId: 1, address: '0x0d88eD6E74bbFD96B831231638b66C05571e824F' as `0x${string}`, symbol: 'AVT', name: 'Aventus', decimals: 18,
  },
}

// DECIMALS_OVERRIDES — same address, CORRECTED decimals (each value = on-chain decimals(),
// verified via eth_call; fund-affecting — the swap path sizes amounts with token.decimals):
const DECIMALS_OVERRIDES: Record<string, number> = {
  '1:0x720cd16b011b987da3518fbf38c3071d4f0d1495': 8, // FLUX (RunOnFlux) — on-chain 8, lists carry 18.
  '8453:0x3e31966d4f81c72d2a55310a6365a56a4393e98d': 6, // WMTX (World Mobile Token, Base) — on-chain 6, lists carry 18.
}

export function applyCuratedCorrections(entries: SourceEntry[]): SourceEntry[] {
  const out: SourceEntry[] = []
  for (const e of entries) {
    const key = `${e.chainId}:${e.address.toLowerCase()}`
    if (REMOVALS.has(key)) continue
    const remap = REMAPS[key]
    let entry = remap ? { ...remap, logoURI: undefined, source: e.source } : e
    const decimalsKey = `${entry.chainId}:${entry.address.toLowerCase()}`
    if (Object.prototype.hasOwnProperty.call(DECIMALS_OVERRIDES, decimalsKey)) {
      entry = { ...entry, decimals: DECIMALS_OVERRIDES[decimalsKey] }
    }
    out.push(entry)
  }
  return out
}

/** Seed keys the corrections REMOVE — applied to seed maps too (a removed token must not
 *  ride back in through the seed-preservation path). */
export function isCuratedRemoval(chainId: number, address: string): boolean {
  return REMOVALS.has(`${chainId}:${address.toLowerCase()}`)
}

// Bridged USDT on Base — Uniswap's Base list omits it; sourced + spot-checked from the
// CoinGecko Base list (v430.1.0, 2026-06-08) in SPRINT-9Y. Kept as a curated seed so a
// source outage can never drop it.
export const CURATED_BASE_SEEDS: SeedToken[] = [
  {
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' as `0x${string}`,
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    category: 'Stablecoin',
  },
]
