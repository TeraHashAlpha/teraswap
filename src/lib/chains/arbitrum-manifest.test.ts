/**
 * [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] Full-address regression guard.
 *
 * AUDIT-ARBITRUM-46-47's HIGH findings included an "unguarded" gap: the prior regression test
 * (routers.test.ts) pinned ROUTER whitelist values only — nothing asserted that the OTHER
 * CHAIN_CONFIGS[42161] addresses (tokens, Chainlink feeds, the sequencer feed) matched their
 * verified values. This is the static (no network), CI-safe counterpart to
 * scripts/verify-arbitrum-addresses.mjs: it diffs the LIVE config against the manifest that
 * script's last verification run emitted (docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json), for
 * EVERY address in the manifest — a silent hand-edit to ANY 42161 address (token, feed,
 * sequencer, or router/contract) now fails CI, not just a router change.
 *
 * This test does NOT hit the network — it trusts the manifest (which was network-verified when
 * generated) and only asserts the live TypeScript config still matches it byte-for-byte
 * (case-insensitively, since EVM addresses are case-insensitive and only display casing differs).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getChainConfig } from './registry'
import { CHAINLINK_FEEDS_BY_CHAIN } from './chainlink-feeds'
import { ROUTER_WHITELIST_BY_CHAIN } from './routers'
import { getUniswapV3Contracts } from './uniswap-v3'
import { CHAIN_TOKENS } from './tokens'

const MANIFEST_PATH = join(process.cwd(), 'docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json')

interface ManifestEntry {
  category: 'token' | 'feed' | 'sequencer' | 'contract'
  key: string
  address: string
  ok: boolean
}
interface Manifest {
  generatedAt: string
  entries: ManifestEntry[]
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

/** Resolve the LIVE (current TypeScript config) value for a manifest entry, or null if not found. */
function resolveLive(entry: ManifestEntry): string | null {
  const chain42161 = getChainConfig(42161)
  switch (entry.category) {
    case 'token':
      return (chain42161.tokens as Record<string, string>)[entry.key] ?? null
    case 'sequencer':
      return chain42161.sequencerUptimeFeed ?? null
    case 'feed': {
      // Feeds are keyed by TOKEN address in CHAINLINK_FEEDS_BY_CHAIN — find the value that
      // matches (the manifest doesn't need to know the map's key shape, just its values).
      const feeds = Object.values(CHAINLINK_FEEDS_BY_CHAIN[42161] ?? {})
      return feeds.find((f) => f.toLowerCase() === entry.address.toLowerCase()) ?? null
    }
    case 'contract': {
      if (entry.key === 'permit2') return chain42161.contracts.permit2
      if (entry.key === 'cowVaultRelayer') return chain42161.contracts.cowVaultRelayer ?? null
      if (entry.key.startsWith('router:')) {
        const routerKey = entry.key.slice('router:'.length)
        return (ROUTER_WHITELIST_BY_CHAIN[42161] as Record<string, string>)[routerKey] ?? null
      }
      if (entry.key === 'uniswapV3:factory') return getUniswapV3Contracts(42161)?.factory ?? null
      if (entry.key === 'uniswapV3:quoterV2') return getUniswapV3Contracts(42161)?.quoterV2 ?? null
      return null
    }
    default:
      return null
  }
}

describe('Arbitrum (42161) — FULL address manifest guard [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION]', () => {
  const manifest = loadManifest()

  it('the manifest itself only records entries that PASSED verification', () => {
    // A failing verification run never writes the manifest (see verify-arbitrum-addresses.mjs) —
    // this is a sanity check that we're not silently trusting a stale/corrupt file.
    for (const e of manifest.entries) {
      expect(e.ok, `manifest entry ${e.category}/${e.key} was NOT ok when verified`).toBe(true)
    }
  })

  it('covers every category (tokens, feeds, sequencer, routers/contracts) — not routers-only', () => {
    const categories = new Set(manifest.entries.map((e) => e.category))
    expect(categories).toEqual(new Set(['token', 'feed', 'sequencer', 'contract']))
    expect(manifest.entries.length).toBeGreaterThanOrEqual(24)
  })

  it.each(
    (() => {
      const m = loadManifest()
      return m.entries.map((e) => [`${e.category}/${e.key}`, e] as const)
    })(),
  )('%s matches the live config (manifest: %o)', (_label, entry) => {
    const live = resolveLive(entry)
    expect(live, `no live value resolved for ${entry.category}/${entry.key}`).not.toBeNull()
    expect(live!.toLowerCase()).toBe(entry.address.toLowerCase())
  })
})

// [CHORE-47C-ARBITRUM-CATALOG] The token CATALOG (CHAIN_TOKENS[42161] / tokens.ts) is a
// SEPARATE structure from the raw registry token map (chain42161.tokens, already diffed above)
// — the catalog is what the UI's token selector actually renders. A hand-edit here would drift
// silently from the manifest without the guard above catching it, so it gets diffed too.
describe('Arbitrum (42161) — CATALOG addresses match the manifest [CHORE-47C-ARBITRUM-CATALOG]', () => {
  const manifest = loadManifest()
  const catalogTokenEntries = manifest.entries.filter(
    (e) => e.category === 'token' && ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC'].includes(e.key),
  )

  it('the manifest has all 5 launch-catalog token entries', () => {
    expect(catalogTokenEntries).toHaveLength(5)
  })

  it.each(catalogTokenEntries.map((e) => [e.key, e] as const))(
    'catalog token %s matches the manifest address',
    (_key, entry) => {
      const catalogEntry = CHAIN_TOKENS[42161]?.find((t) => t.symbol === entry.key)
      expect(catalogEntry, `catalog is missing token ${entry.key}`).toBeDefined()
      expect(catalogEntry!.address.toLowerCase()).toBe(entry.address.toLowerCase())
    },
  )

  it('the catalog is EXACTLY the 5-token launch set — a 6th token requires updating this test', () => {
    expect(CHAIN_TOKENS[42161]).toHaveLength(5)
  })
})
