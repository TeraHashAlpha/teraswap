#!/usr/bin/env tsx
/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] tokens:sync — the build-time token-catalog pipeline.
 *
 *   npm run tokens:sync            (npx tsx --tsconfig tsconfig.json scripts/token-catalog/build.ts)
 *
 * Per chain (mainnet 1 + Base 8453):
 *   fetch (uniswap [vendored fallback] / coingecko / 1inch / trustwallet / superchain[Base])
 *   → normalize + curated corrections → merge by (chainId, EIP-55 address)
 *   → DefiLlama market signal → cross-verify (>=2 sources, >=3 low-liquidity)
 *   → symbol-conflict resolution → route through the EXISTING catalog guard
 *     (shared verdict collector + auditChain — PRs #209–#211, reused)
 *   → assemble (cores forced, seeds preserved) → write the committed catalog:
 *         src/config/generated/token-catalog.<chainId>.json
 *   → refresh src/lib/chains/catalog-guard.trust.json from the SAME verdicts.
 *
 * Environment: GUARD_RPC_1 / GUARD_RPC_8453 override the default publicnode RPCs
 * (same knobs as guard:refresh). No API keys required.
 *
 * A source outage NEVER fails the build (logged + continued). The build FAILS only when a
 * CORE token cannot be guard-validated (fail-closed on fund/routing-critical tokens).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DEFAULT_TOKENS } from '@/lib/tokens'
import { NATIVE_ETH } from '@/lib/constants'
import { GENERATED_TOKEN_CATALOG } from '@/lib/chains/token-catalog.generated'
import type { Allowlist, Verdict } from '@/lib/chains/catalog-guard'
import allowlistJson from '@/lib/chains/catalog-guard.allowlist.json'
import { CATEGORY_OVERRIDES } from '../token-category-overrides'
import { PIPELINE_CONFIG, CORE_TOKENS } from './lib/config'
import seedBaseline from './seed-baseline.json'
import type { SeedToken } from './lib/types'
import { buildChainCatalog } from './lib/build-chain'
import { makeFetchers, makeMarketFetcher } from './lib/fetch-sources'
import { makeCategoryResolver } from './lib/category'
import { applyCuratedCorrections, correctSeed, CURATED_BASE_SEEDS } from './lib/curated'
import { collectVerdicts, writeTrustFixture, GUARD_CHAINS } from './lib/verdicts'

const OUT_DIR = path.join('src', 'config', 'generated')

// Mirrors the runtime CORE_LOCAL_LOGO in src/lib/chains/tokens.ts — bundled, validated,
// never-404 brand assets. Everything else uses the /api/token-logo route (CoinGecko-first
// server-side, DefiLlama fallback) — the documented <TokenLogo> chain, all CSP 'self'.
const CORE_LOCAL_LOGO: Record<string, string> = {
  ETH: '/tokens/eth.png',
  WETH: '/tokens/weth.png',
  USDC: '/tokens/usdc.png',
  USDT: '/tokens/usdt.png',
  DAI: '/tokens/dai.png',
  cbETH: '/tokens/cbeth.png',
  WBTC: '/tokens/wbtc.png',
  LINK: '/tokens/link.png',
  UNI: '/tokens/uni.png',
  USDbC: '/tokens/usdbc.png',
}

function logoFor(chainId: number, address: string, symbol: string): string {
  return CORE_LOCAL_LOGO[symbol] ?? `/api/token-logo?chainId=${chainId}&address=${address.toLowerCase()}`
}

/**
 * Current-catalog seeds for a chain (the never-silently-drop set):
 *  - DEFAULT_TOKENS (mainnet hand-curated list)
 *  - the committed SEED BASELINE (the pinned catalog at pipeline introduction — extracted
 *    programmatically, see seed-baseline.json)
 *  - curated Base additions
 *  - PLUS previous-run additions ONLY while they remain VERIFIED — an addition that later
 *    loses its source agreement washes out instead of ratcheting in as a permanent ⚠ row
 *    (adversarial-review follow-up: without the baseline, one loose run would seed the
 *    next forever).
 *  Minus native ETH (core-handled). Every seed passes through correctSeed — the same
 *  curated removals/remaps as source entries — so a remapped deprecated address (OHM v1,
 *  KNC legacy) can never ride back in through the seed path [CHORE-OHM-KNC-REMAP].
 */
function seedsFor(chainId: number): Map<string, SeedToken> {
  const seeds = new Map<string, SeedToken>()
  const push = (raw: SeedToken) => {
    if (raw.address.toLowerCase() === NATIVE_ETH.toLowerCase()) return
    const s = correctSeed(chainId, raw)
    if (!s) return // curated removal
    const k = s.address.toLowerCase()
    if (!seeds.has(k)) seeds.set(k, s)
  }
  if (chainId === 1) {
    for (const t of DEFAULT_TOKENS) {
      push({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, category: t.category, logoURI: t.logoURI })
    }
  }
  const baseline = (seedBaseline as unknown as Record<string, SeedToken[]>)[String(chainId)] ?? []
  for (const t of baseline) {
    push({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals })
  }
  if (chainId === 8453) for (const s of CURATED_BASE_SEEDS) push(s)
  for (const t of GENERATED_TOKEN_CATALOG[chainId] ?? []) {
    if (!t.verified) continue // post-baseline additions persist only while verified
    push({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals })
  }
  return seeds
}

function categoryResolver() {
  const seedCategories = new Map<string, string>()
  for (const t of DEFAULT_TOKENS) seedCategories.set(`1:${t.address.toLowerCase()}`, t.category)
  for (const s of CURATED_BASE_SEEDS) {
    if (s.category) seedCategories.set(`8453:${s.address.toLowerCase()}`, s.category)
  }
  const overrides = new Map<string, string>()
  for (const [addr, cat] of Object.entries(CATEGORY_OVERRIDES)) overrides.set(`1:${addr.toLowerCase()}`, cat)
  return makeCategoryResolver({ seedCategories, overrides })
}

async function run() {
  const log = (m: string) => console.error(m)
  const allowlist = allowlistJson as unknown as Allowlist
  const categoryFor = categoryResolver()
  const allVerdicts: Verdict[] = []
  fs.mkdirSync(OUT_DIR, { recursive: true })

  for (const chainId of PIPELINE_CONFIG.chains) {
    log(`\n━━ chain ${chainId} ━━`)
    const { fetchers, getCgSet } = makeFetchers(chainId)
    const result = await buildChainCatalog(chainId, {
      fetchSources: fetchers.map((f) => async () => {
        const r = await f()
        return { ...r, entries: applyCuratedCorrections(r.entries) }
      }),
      fetchMarket: makeMarketFetcher(chainId),
      collectVerdicts: (tokens) => {
        const cg = getCgSet()
        return collectVerdicts(tokens, { log, cgSets: cg ? new Map([[chainId, cg]]) : undefined })
      },
      allowlist,
      seeds: seedsFor(chainId),
      cores: CORE_TOKENS[chainId],
      config: PIPELINE_CONFIG,
      categoryFor,
      logoFor,
      log,
    })

    // keep only verdicts for tokens that actually shipped (the guard gate audits the
    // final catalog; extra rows would go stale as sources churn)
    const shipped = new Set(result.tokens.map((t) => t.address.toLowerCase()))
    allVerdicts.push(...result.verdicts.filter((v) => shipped.has(v.address.toLowerCase())))

    const file = path.join(OUT_DIR, `token-catalog.${chainId}.json`)
    const payload = {
      $comment:
        'AUTO-GENERATED by scripts/token-catalog/build.ts (npm run tokens:sync) — DO NOT EDIT BY HAND. ' +
        'Cross-verified multi-source token catalog; see docs/Prompts/CHORE-TOKEN-CATALOG-PIPELINE.md. ' +
        'verified:true = >=minSources independent sources agreed on this (chainId, EIP-55 address) AND the catalog guard passed it on-chain.',
      schemaVersion: 1,
      chainId,
      config: {
        minSources: PIPELINE_CONFIG.minSources,
        lowLiqMinSources: PIPELINE_CONFIG.lowLiqMinSources,
        liquidityFloorUsd: PIPELINE_CONFIG.liquidityFloorUsd,
        defillamaConfidenceMin: PIPELINE_CONFIG.defillamaConfidenceMin,
        maxNewTokensPerChain: PIPELINE_CONFIG.maxNewTokensPerChain[chainId] ?? null,
        requiredSourceForNew: PIPELINE_CONFIG.requiredSourceForNew,
      },
      sourcesUsed: [...result.sourcesUsed].sort(),
      counts: { included: result.report.included, verified: result.report.verified },
      tokens: result.tokens,
    }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')

    // ── build report (feeds FEEDBACK) ──
    log(`\nwrote ${file}`)
    log(`  sources used: ${payload.sourcesUsed.join(', ') || 'NONE'}`)
    for (const n of result.sourceNotes) log(`  note: ${n}`)
    log(`  included: ${result.report.included} (verified: ${result.report.verified})`)
    if (result.report.unverifiedSeeds.length) {
      log(`  UNVERIFIED SEEDS (kept, honest ⚠ — flag in FEEDBACK):`)
      for (const s of result.report.unverifiedSeeds) log(`    ${s.symbol} ${s.address} — ${s.reason}`)
    }
    if (result.report.conflicts.length) {
      log(`  symbol conflicts (kept canonical, rejected rest):`)
      for (const c of result.report.conflicts) log(`    ${c.symbol}: kept ${c.kept}, rejected ${c.rejected.join(', ')}`)
    }
    if (result.report.capped.length) log(`  capped (over maxNewTokensPerChain): ${result.report.capped.length}`)
    const byReason = new Map<string, number>()
    for (const r of result.report.rejections) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1)
    for (const [reason, n] of byReason) log(`  rejected ${reason}: ${n}`)
  }

  const { file, count } = writeTrustFixture(allVerdicts, GUARD_CHAINS)
  log(`\nrefreshed ${file}: ${count} verdicts (same pass as the catalog build)`)
}

run().catch((e) => {
  console.error(`\nBUILD FAILED: ${e?.message ?? e}`)
  process.exit(1)
})
