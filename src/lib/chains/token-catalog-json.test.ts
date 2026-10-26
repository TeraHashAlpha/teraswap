/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Invariants of the COMMITTED generated catalogs
 * (src/config/generated/token-catalog.<chainId>.json). NO network — this is the
 * deterministic CI gate over what `npm run tokens:sync` produced:
 *
 *  - schema + chainId sanity
 *  - every address is EIP-55 with valid integer decimals (anti address-typo)
 *  - no duplicate address and no duplicate symbol per chain (anti-spoofing — mirrors
 *    the guard's duplicate-symbol fatal)
 *  - every CORE token (fee/routing-critical allowlist) is present, verified, core:true
 *  - verified:true rows carry the agreement evidence: >=2 external sources, or the
 *    native sentinel, or a pinned core, or (feat/catalog-single-source-volume) ONE source plus a
 *    valid `admission` object proving the 7-day volume rule
 *  - every logoURI is CSP-'self' (/tokens/* bundled asset or the /api/token-logo route)
 *    — no third-party CDN can creep in without a next.config.js img-src review
 */
import { describe, it, expect } from 'vitest'
import { getAddress } from 'viem'
import { NATIVE_ETH } from '@/lib/constants'
import { GENERATED_TOKEN_CATALOG, type GeneratedToken } from './token-catalog.generated'
import { CORE_TOKENS, PIPELINE_CONFIG } from '../../../scripts/token-catalog/lib/config'
import { resolveSingleSourceConfig, medianOf } from '../../../scripts/token-catalog/lib/verify'
import catalog1 from '@/config/generated/token-catalog.1.json'
import catalog8453 from '@/config/generated/token-catalog.8453.json'
import catalog42161 from '@/config/generated/token-catalog.42161.json'

const FILES: Array<[number, { schemaVersion: number; chainId: number; counts: { included: number; verified: number } }]> = [
  [1, catalog1],
  [8453, catalog8453],
  [42161, catalog42161],
]

// External (agreement-counting) sources — 'curated'/'native' are provenance markers and
// 'defillama' is market-signal-only (its identity row is near-automatic for any priced
// pool, so it never counts toward the agreement floor).
const NON_VOTING = new Set(['curated', 'native', 'defillama'])

// [feat/catalog-single-source-volume] An `admission` row is verified on ONE source + volume. It is
// only acceptable when the recorded evidence proves the rule: a single CoinGecko vote, `days`
// daily values, and every day (or the median, if requireEveryDay is off) >= the floor it records.
export function admissionProblem(t: GeneratedToken, chainId: number): string | null {
  const a = t.admission
  if (!a) return 'no admission'
  if (a.rule !== 'single-source-volume') return `unknown rule ${String(a.rule)}`
  const votes = t.sources.filter((s) => !NON_VOTING.has(s))
  if (votes.length !== 1 || votes[0] !== 'coingecko') return `needs exactly one coingecko vote, has [${votes.join(',')}]`
  if (!Array.isArray(a.dailyVolumeUsd) || a.dailyVolumeUsd.length !== a.days) return `dailyVolumeUsd length != days (${a.days})`
  if (!a.dailyVolumeUsd.every((v) => Number.isFinite(v) && v >= 0)) return 'non-finite/negative daily volume'
  const { requireEveryDay } = resolveSingleSourceConfig(PIPELINE_CONFIG, chainId)
  const pass = requireEveryDay ? a.dailyVolumeUsd.every((v) => v >= a.minDailyVolumeUsd) : medianOf(a.dailyVolumeUsd) >= a.minDailyVolumeUsd
  return pass ? null : `volume evidence below the recorded floor ${a.minDailyVolumeUsd}`
}

describe('admissionProblem — the gate accepts a valid single-source admission and rejects a forged one', () => {
  const row = (over: Partial<GeneratedToken> = {}): GeneratedToken => ({
    address: '0x0000000000000000000000000000000000000001', symbol: 'X', name: 'X', decimals: 18, logoURI: '/api/token-logo?x', category: 'Other',
    verified: true, sources: ['coingecko'],
    admission: { rule: 'single-source-volume', dailyVolumeUsd: Array(7).fill(150_000), minDailyVolumeUsd: 100_000, days: 7 },
    ...over,
  })
  it('valid → no problem', () => expect(admissionProblem(row(), 8453)).toBeNull())
  it.each([
    ['a day under the floor', row({ admission: { rule: 'single-source-volume', dailyVolumeUsd: [150_000, 150_000, 99_999, 150_000, 150_000, 150_000, 150_000], minDailyVolumeUsd: 100_000, days: 7 } })],
    ['only 6 values for days=7', row({ admission: { rule: 'single-source-volume', dailyVolumeUsd: Array(6).fill(150_000), minDailyVolumeUsd: 100_000, days: 7 } })],
    ['a non-coingecko single vote', row({ sources: ['oneinch'] })],
    ['two votes (admission is for single-source only)', row({ sources: ['uniswap', 'coingecko'] })],
    ['no admission at all', row({ admission: undefined })],
  ])('rejects %s', (_n, r) => expect(admissionProblem(r, 8453)).not.toBeNull())
})

describe.each(FILES)('token-catalog.%i.json — committed catalog invariants', (chainId, file) => {
  const tokens: GeneratedToken[] = GENERATED_TOKEN_CATALOG[chainId]

  it('has the expected schema and chain', () => {
    // [fix/token-sync-cron-landing] build.ts has emitted schemaVersion 2 since
    // fix/token-search-ranking-squatting (volume24hUsd/volumeSource/volumeFetchedAt fields) —
    // this assertion was never bumped, so ANY regen (regardless of the GUARD_CHAINS/trusted-
    // list fixes in this branch) would fail the gate here on schema mismatch alone. See
    // FEEDBACK: this is a third, independent contributor to the cron's failure streak.
    expect(file.schemaVersion).toBe(2)
    expect(file.chainId).toBe(chainId)
    expect(file.counts.included).toBe(tokens.length)
    expect(file.counts.verified).toBe(tokens.filter((t) => t.verified).length)
    expect(tokens.length).toBeGreaterThan(50)
  })

  it('every address is canonical EIP-55 with valid integer decimals', () => {
    for (const t of tokens) {
      expect(getAddress(t.address)).toBe(t.address)
      expect(Number.isInteger(t.decimals)).toBe(true)
      expect(t.decimals).toBeGreaterThanOrEqual(0)
      expect(t.decimals).toBeLessThanOrEqual(36)
    }
  })

  it('has no duplicate address and no duplicate symbol (anti-spoofing)', () => {
    const addrs = tokens.map((t) => t.address.toLowerCase())
    expect(new Set(addrs).size).toBe(addrs.length)
    const symbols = tokens.map((t) => t.symbol.toLowerCase())
    expect(new Set(symbols).size).toBe(symbols.length)
  })

  it('every core token is present, verified and flagged core (outage cannot drop them)', () => {
    const byAddr = new Map(tokens.map((t) => [t.address.toLowerCase(), t]))
    for (const core of CORE_TOKENS[chainId]) {
      const row = byAddr.get(core.address.toLowerCase())
      expect(row, `core ${core.symbol} missing`).toBeDefined()
      expect(row!.symbol).toBe(core.symbol)
      expect(row!.decimals).toBe(core.decimals)
      expect(row!.verified).toBe(true)
      expect(row!.core).toBe(true)
    }
  })

  it('the native ETH sentinel is present exactly once and verified via the native source', () => {
    const native = tokens.filter((t) => t.address.toLowerCase() === NATIVE_ETH.toLowerCase())
    expect(native).toHaveLength(1)
    expect(native[0].sources).toEqual(['native'])
    expect(native[0].verified).toBe(true)
  })

  it('verified:true always carries agreement evidence (>=2 external sources, native, core, or a valid single-source admission)', () => {
    for (const t of tokens) {
      if (!t.verified) continue
      const votes = t.sources.filter((s) => !NON_VOTING.has(s)).length
      const ok = votes >= 2 || t.sources.includes('native') || t.core === true || admissionProblem(t, chainId) === null
      expect(ok, `${t.symbol} ${t.address} verified without evidence (sources: ${t.sources.join(',')}; admission: ${admissionProblem(t, chainId)})`).toBe(true)
    }
  })

  it('every admission row is verified and its admission evidence is self-consistent', () => {
    for (const t of tokens.filter((x) => x.admission)) {
      expect(t.verified, `${t.symbol} carries admission but is not verified`).toBe(true)
      expect(admissionProblem(t, chainId), `${t.symbol} ${t.address} bad admission`).toBeNull()
    }
  })

  it('unverified rows still record their provenance (never an empty sources list)', () => {
    for (const t of tokens) expect(t.sources.length, `${t.symbol} has no sources`).toBeGreaterThan(0)
  })

  it("every logoURI is CSP-'self' (bundled /tokens/* or the /api/token-logo route)", () => {
    for (const t of tokens) {
      const ok = t.logoURI.startsWith('/tokens/') || t.logoURI.startsWith('/api/token-logo?')
      expect(ok, `${t.symbol} logoURI not 'self': ${t.logoURI}`).toBe(true)
    }
  })
})
