/**
 * [fix/catalog-refresh-drops-untrusted] refresh-decision — the three real failures (issues #700,
 * #703, #706) as frozen fixtures, seeded properties, the cap boundaries, the dead-upstream paths,
 * the PR-body rendering. No network.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditChain, fatal, type Allowlist, type Verdict } from '@/lib/chains/catalog-guard'
import allowlistJson from '@/lib/chains/catalog-guard.allowlist.json'
import { deriveGuardOutcomes } from './guard-gate'
import type { CatalogRow, GuardOutcome } from './types'
import {
  decideRefresh,
  removalLimit,
  renderBlockedSummary,
  renderPrBodySections,
  sanitizeInline,
  trustedListVerdict,
  LEFT_OUT_HEADING,
  MAX_REMOVED_ABS,
  REMOVED_HEADING,
  type RefreshDecisionInput,
} from './refresh-decision'

const allowlist = allowlistJson as unknown as Allowlist
const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'refresh-decision-real-cases.json'), 'utf8')) as {
  chains: Record<string, { previousSize: number; previousCoingeckoSourceCount: number; rows: CatalogRow[]; verdicts: Verdict[] }>
  freshCoingeckoListSize: Record<string, number>
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────
const hex = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`

function row(n: number, over: Partial<CatalogRow> = {}): CatalogRow {
  return {
    address: hex(n), symbol: `T${n}`, name: `Token ${n}`, decimals: 18, category: 'Other', logoURI: '/x', verified: true,
    sources: ['uniswap', 'coingecko'], volume24hUsd: 0, volumeSource: null, volumeFetchedAt: null, ...over,
  } as CatalogRow
}

/** Audit stub keyed by address: fatal for the given set, pass otherwise. */
function stubAudit(fatalAddrs: ReadonlySet<string>) {
  return (rows: readonly CatalogRow[]): ReadonlyMap<string, GuardOutcome> =>
    new Map(rows.map((r) => [r.address.toLowerCase(), fatalAddrs.has(r.address.toLowerCase()) ? { status: 'fatal' as const, detail: 'trusted-list: stub' } : { status: 'pass' as const }]))
}

const healthy = { previous: 1000, current: 990 }

/** mulberry32 — deterministic, seedable. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── the three real cases ───────────────────────────────────────────────────────────────────
describe('refresh-decision — the three real failures (issues #700 #703 #706)', () => {
  const EXPECTED: Record<string, string[]> = {
    '1': ['APW', 'CRPT', 'FRM', 'KEY', 'MULTI', 'POLC', 'PSTAKE', 'RGT', 'TKN', 'TKX', 'TONE', 'TVK', 'UFT', 'USDN', 'XCAD'],
    '8453': ['PSTAKE'],
    '42161': ['LIQD', 'RGT'],
  }

  for (const [chain, expected] of Object.entries(EXPECTED)) {
    describe(`chain ${chain}`, () => {
      const f = fixture.chains[chain]
      const chainId = Number(chain)
      // previous = the 18 real rows + clean synthetic filler up to the real catalog size that day
      const filler = Array.from({ length: f.previousSize - f.rows.length }, (_, i) => row(0xa0000 + chainId * 100000 + i))
      const previous: CatalogRow[] = [...f.rows, ...filler]
      const verdicts: Verdict[] = [
        ...f.verdicts,
        ...filler.map((r) => ({ chainId, address: r.address, symbol: r.symbol, inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: r.symbol, decimals: 18 })),
      ]
      const audit = (rows: readonly CatalogRow[]) => deriveGuardOutcomes(chainId, [...rows], verdicts, allowlist)
      const input: RefreshDecisionInput = {
        chainId, previous, candidate: previous, audit, protectedAddresses: new Set(),
        trustedList: { previous: f.previousCoingeckoSourceCount, current: fixture.freshCoingeckoListSize[chain] },
      }

      it('precondition: the old pipeline output really is red (only trusted-list fatals, exactly the issue list)', () => {
        const findings = fatal(auditChain(chainId, previous, verdicts, allowlist))
        expect(findings.every((x) => x.check === 'trusted-list')).toBe(true)
        expect(findings.map((x) => x.symbol).sort()).toEqual([...expected].sort())
      })

      it('the refresh passes: not blocked, removes exactly the issue list, leaves nothing out', () => {
        const d = decideRefresh(input)
        expect(d.blocked).toBeNull()
        expect(d.removed.map((l) => l.symbol).sort()).toEqual([...expected].sort())
        expect(d.leftOut).toEqual([])
        expect(d.catalog).toHaveLength(f.previousSize - expected.length)
        for (const l of d.removed) {
          expect(l.why).toContain('guard: trusted-list')
          expect(l.why).not.toContain('add to the allowlist') // remediation advice for an allowlist editor, not for the PR reader
        }
      })

      it('the guard is green on the result (same auditChain the CI gate runs)', () => {
        const d = decideRefresh(input)
        expect(fatal(auditChain(chainId, d.catalog, verdicts, allowlist))).toEqual([])
      })

      it('no token other than the 18 is touched (removed + kept = previous)', () => {
        const d = decideRefresh(input)
        const keptSet = new Set(d.catalog.map((r) => r.address))
        expect(previous.filter((r) => !keptSet.has(r.address)).map((r) => r.address).sort()).toEqual(d.removed.map((l) => l.address).sort())
      })

      it('real removals fit the cap (this is a normal refresh, not a blocked one)', () => {
        expect(expected.length).toBeLessThanOrEqual(removalLimit(f.previousSize))
      })
    })
  }

  it('chain 1 sample PR body opens with the removals section, one line per token', () => {
    const f = fixture.chains['1']
    const chainId = 1
    const filler = Array.from({ length: f.previousSize - f.rows.length }, (_, i) => row(0xa0000 + i))
    const previous = [...f.rows, ...filler]
    const verdicts: Verdict[] = [...f.verdicts, ...filler.map((r) => ({ chainId, address: r.address, symbol: r.symbol, inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: r.symbol, decimals: 18 }))]
    const d = decideRefresh({
      chainId, previous, candidate: previous, audit: (rows) => deriveGuardOutcomes(chainId, [...rows], verdicts, allowlist),
      protectedAddresses: new Set(), trustedList: { previous: f.previousCoingeckoSourceCount, current: fixture.freshCoingeckoListSize['1'] },
    })
    const body = renderPrBodySections(d, new Map([[f.rows[2].address.toLowerCase(), 321.5]]))
    expect(body.startsWith(`## ${REMOVED_HEADING}\n`)).toBe(true)
    expect(body.indexOf(REMOVED_HEADING)).toBeLessThan(body.indexOf(LEFT_OUT_HEADING))
    for (const r of f.rows) expect(body).toContain(r.address)
    expect(body.split('\n').filter((l) => l.startsWith('- chain 1 · ')).length).toBe(15)
    expect(body).toContain('7-day volume $322') // FRM, looked up
    expect(body).toContain('7-day volume n/a') // the rest, no data
  })
})

// ── what each rule does ────────────────────────────────────────────────────────────────────
describe('refresh-decision — new candidate vs token already on the site', () => {
  it('a NEW fatal candidate is left out and never blocks the chain', () => {
    const previous = Array.from({ length: 50 }, (_, i) => row(i + 1))
    const fresh = [row(900), row(901)]
    const d = decideRefresh({
      chainId: 1, previous, candidate: [...previous, ...fresh], audit: stubAudit(new Set([hex(900)])), protectedAddresses: new Set(), trustedList: healthy,
    })
    expect(d.blocked).toBeNull()
    expect(d.leftOut.map((l) => l.address)).toEqual([hex(900)])
    expect(d.removed).toEqual([])
    expect(d.catalog.map((r) => r.address)).toContain(hex(901))
    expect(d.catalog.map((r) => r.address)).not.toContain(hex(900))
  })

  it('a fatal token ALREADY on the site is removed and listed', () => {
    const previous = Array.from({ length: 50 }, (_, i) => row(i + 1))
    const d = decideRefresh({ chainId: 1, previous, candidate: previous, audit: stubAudit(new Set([hex(7)])), protectedAddresses: new Set(), trustedList: healthy })
    expect(d.removed).toHaveLength(1)
    expect(d.removed[0]).toMatchObject({ chainId: 1, symbol: 'T7', address: hex(7) })
    expect(d.catalog).toHaveLength(49)
  })

  it('a row the pipeline itself dropped is removed with the pipeline\'s reason, and counts toward the cap', () => {
    const previous = Array.from({ length: 100 }, (_, i) => row(i + 1))
    const candidate = previous.filter((r) => r.address !== hex(3))
    const d = decideRefresh({
      chainId: 1, previous, candidate, audit: stubAudit(new Set()), protectedAddresses: new Set(), trustedList: healthy,
      pipelineDropReasons: new Map([[hex(3), 'not in any trusted list, 1 external vote(s) < 2 required']]),
    })
    expect(d.removed).toHaveLength(1)
    expect(d.removed[0].why).toContain('dropped by the pipeline: not in any trusted list')
  })

  it('a protected (core / hand-pinned) fatal token blocks the chain instead of being removed', () => {
    const previous = Array.from({ length: 50 }, (_, i) => row(i + 1))
    const d = decideRefresh({ chainId: 1, previous, candidate: previous, audit: stubAudit(new Set([hex(2)])), protectedAddresses: new Set([hex(2)]), trustedList: healthy })
    expect(d.blocked?.reason).toBe('protected-token-fatal')
    expect(d.catalog).toEqual(previous)
    expect(d.removed).toEqual([])
  })

  it('a result the guard still calls fatal (cascade) blocks the chain', () => {
    const previous = Array.from({ length: 50 }, (_, i) => row(i + 1))
    // T9 is only fatal while T8 is present AND T8 is removed -> a partner left red after the drop
    const audit = (rows: readonly CatalogRow[]) =>
      new Map(rows.map((r): [string, GuardOutcome] => [r.address.toLowerCase(), r.address === hex(8) || r.address === hex(9) ? { status: 'fatal', detail: 'x' } : { status: 'pass' }]))
    const d = decideRefresh({ chainId: 1, previous, candidate: previous, audit: (rows) => audit(rows), protectedAddresses: new Set(), trustedList: healthy })
    // both fatal -> both removed -> clean: NOT blocked (the cascade case below is the blocked one)
    expect(d.blocked).toBeNull()
    const sticky = (rows: readonly CatalogRow[]): ReadonlyMap<string, GuardOutcome> => {
      const present = new Set(rows.map((r) => r.address))
      return new Map(rows.map((r): [string, GuardOutcome] => [r.address.toLowerCase(), r.address === hex(8) ? { status: 'fatal', detail: 'x' } : r.address === hex(9) && !present.has(hex(8)) ? { status: 'fatal', detail: 'y' } : { status: 'pass' }]))
    }
    const d2 = decideRefresh({ chainId: 1, previous, candidate: previous, audit: sticky, protectedAddresses: new Set(), trustedList: healthy })
    expect(d2.blocked?.reason).toBe('residual-fatal')
    expect(d2.catalog).toEqual(previous)
  })

  it('an unverifiable (RPC unreadable) row is NOT removed — only the guard\'s fatal verdicts are acted on', () => {
    const previous = Array.from({ length: 30 }, (_, i) => row(i + 1))
    const audit = (rows: readonly CatalogRow[]) => new Map(rows.map((r): [string, GuardOutcome] => [r.address.toLowerCase(), { status: 'unverifiable' }]))
    const d = decideRefresh({ chainId: 1, previous, candidate: previous, audit, protectedAddresses: new Set(), trustedList: healthy })
    expect(d.blocked).toBeNull()
    expect(d.catalog).toHaveLength(30)
    expect(d.removed).toEqual([])
  })
})

// ── the cap ────────────────────────────────────────────────────────────────────────────────
describe('refresh-decision — the removal cap (20 tokens or 5% of the chain)', () => {
  const sizes = [0, 1, 19, 20, 39, 40, 41, 100, 399, 400, 401, 419, 420, 1000, 5000]
  for (const size of sizes) {
    it(`previous ${size}: limit ${removalLimit(size)} passes, limit + 1 blocks`, () => {
      const limit = removalLimit(size)
      expect(limit).toBeLessThanOrEqual(MAX_REMOVED_ABS)
      expect(limit).toBe(Math.min(MAX_REMOVED_ABS, Math.floor(size / 20)))
      const previous = Array.from({ length: size }, (_, i) => row(i + 1))
      const run = (n: number) =>
        decideRefresh({ chainId: 1, previous, candidate: previous, audit: stubAudit(new Set(previous.slice(0, n).map((r) => r.address.toLowerCase()))), protectedAddresses: new Set(), trustedList: healthy })
      const atLimit = run(limit)
      expect(atLimit.blocked).toBeNull()
      expect(atLimit.removed).toHaveLength(limit)
      if (limit + 1 <= size) {
        const over = run(limit + 1)
        expect(over.blocked?.reason).toBe('removal-cap')
        expect(over.catalog).toEqual(previous) // changes nothing
        expect(over.removed).toEqual([])
        expect(over.attempted.removed).toHaveLength(limit + 1) // the issue can still show what it would have done
      }
    })
  }

  it('the absolute 20 binds on a big chain; the 5% binds on a small one', () => {
    expect(removalLimit(994)).toBe(20)
    expect(removalLimit(462)).toBe(20)
    expect(removalLimit(389)).toBe(19)
    expect(removalLimit(60)).toBe(3)
  })
})

// ── dead upstream list ─────────────────────────────────────────────────────────────────────
describe('refresh-decision — a dead upstream list changes nothing', () => {
  const previous = Array.from({ length: 200 }, (_, i) => row(i + 1))
  const base = { chainId: 1, previous, candidate: previous, audit: stubAudit(new Set([hex(5)])), protectedAddresses: new Set<string>() }

  it('empty list ⇒ blocked, nothing changed, and not even the one genuinely fatal token is touched', () => {
    const d = decideRefresh({ ...base, trustedList: { previous: 1000, current: 0 } })
    expect(d.blocked?.reason).toBe('trusted-list-dead')
    expect(d.catalog).toEqual(previous)
    expect(d.removed).toEqual([])
    expect(d.leftOut).toEqual([])
  })

  it('unreachable list (null) ⇒ blocked', () => {
    expect(decideRefresh({ ...base, trustedList: { previous: 1000, current: null } }).blocked?.reason).toBe('trusted-list-dead')
  })

  it('missing 30% of the previous list ⇒ blocked; 29% missing ⇒ goes through', () => {
    expect(decideRefresh({ ...base, trustedList: { previous: 1000, current: 700 } }).blocked?.reason).toBe('trusted-list-dead')
    expect(decideRefresh({ ...base, trustedList: { previous: 1000, current: 600 } }).blocked?.reason).toBe('trusted-list-dead')
    expect(decideRefresh({ ...base, trustedList: { previous: 1000, current: 701 } }).blocked).toBeNull()
  })

  it('no previous baseline ⇒ only an empty list blocks', () => {
    expect(trustedListVerdict(null, 5)).toBeNull()
    expect(trustedListVerdict(null, 0)?.reason).toBe('trusted-list-dead')
  })

  it('the real chains: today\'s lists are 88-98% of the previous run — healthy', () => {
    for (const c of ['1', '8453', '42161']) {
      expect(trustedListVerdict(fixture.chains[c].previousCoingeckoSourceCount, fixture.freshCoingeckoListSize[c])).toBeNull()
    }
  })
})

// ── seeded properties ──────────────────────────────────────────────────────────────────────
describe('refresh-decision — seeded properties', () => {
  const SEEDS = [1, 2, 3, 7, 42, 99, 1234, 2026, 31337, 86400]

  for (const seed of SEEDS) {
    it(`seed ${seed}: invariants hold over 60 random refreshes`, () => {
      const rand = rng(seed)
      const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
      for (let iter = 0; iter < 60; iter++) {
        const prevSize = int(0, 600)
        const previous = Array.from({ length: prevSize }, (_, i) => row(i + 1))
        const pipelineDrops = new Set<string>()
        const withDrops = rand() < 0.4
        const candidateOld = previous.filter((r) => {
          if (withDrops && rand() < 0.01) { pipelineDrops.add(r.address.toLowerCase()); return false }
          return true
        })
        const fresh = Array.from({ length: int(0, 30) }, (_, i) => row(100000 + i))
        const candidate = [...candidateOld, ...fresh]
        const fatalAddrs = new Set<string>()
        const fatalRate = [0, 0.005, 0.02, 0.1][int(0, 3)]
        for (const r of candidate) if (rand() < fatalRate) fatalAddrs.add(r.address.toLowerCase())
        const audit = stubAudit(fatalAddrs)
        const d = decideRefresh({ chainId: 1, previous, candidate, audit, protectedAddresses: new Set(), trustedList: healthy })

        if (d.blocked) {
          // blocked ⇒ nothing changes
          expect(d.blocked.reason).toBe('removal-cap')
          expect(d.catalog).toEqual(previous)
          expect(d.removed).toEqual([])
          expect(d.leftOut).toEqual([])
          expect(d.attempted.removed.length).toBeGreaterThan(removalLimit(prevSize))
          continue
        }
        const out = new Set(d.catalog.map((r) => r.address.toLowerCase()))
        // 1. the output never contains a fatal token
        for (const a of out) expect(fatalAddrs.has(a)).toBe(false)
        // 2. nothing is removed that the guard did not call fatal (other than the pipeline's own drops)
        for (const l of d.removed) expect(fatalAddrs.has(l.address.toLowerCase()) || pipelineDrops.has(l.address.toLowerCase())).toBe(true)
        // 3. removed + kept = previous (and they are disjoint)
        const kept = previous.filter((r) => out.has(r.address.toLowerCase()))
        expect(kept.length + d.removed.length).toBe(previous.length)
        expect(new Set([...kept.map((r) => r.address), ...d.removed.map((l) => l.address)]).size).toBe(previous.length)
        // 4. the cap holds
        expect(d.removed.length).toBeLessThanOrEqual(removalLimit(prevSize))
        // 5. every fatal candidate is accounted for exactly once (removed if it was on the site, else left out)
        const prevSet = new Set(previous.map((r) => r.address.toLowerCase()))
        const fatalCandidates = candidate.filter((r) => fatalAddrs.has(r.address.toLowerCase()))
        expect(d.leftOut.map((l) => l.address).sort()).toEqual(fatalCandidates.filter((r) => !prevSet.has(r.address.toLowerCase())).map((r) => r.address).sort())
        // 6. every non-fatal NEW candidate is kept
        for (const r of fresh) if (!fatalAddrs.has(r.address.toLowerCase())) expect(out.has(r.address.toLowerCase())).toBe(true)
      }
    })
  }
})

// ── rendering ──────────────────────────────────────────────────────────────────────────────
describe('refresh-decision — PR body / issue text', () => {
  const previous = Array.from({ length: 100 }, (_, i) => row(i + 1))
  const evil = row(200, { symbol: 'X`](http://evil)\n## injected | <b>' })

  it('always has both headings, "None." when empty, removals first', () => {
    const d = decideRefresh({ chainId: 8453, previous, candidate: previous, audit: stubAudit(new Set()), protectedAddresses: new Set(), trustedList: healthy })
    const body = renderPrBodySections(d)
    expect(body.startsWith(`## ${REMOVED_HEADING}\n\nNone.\n`)).toBe(true)
    expect(body).toContain(`## ${LEFT_OUT_HEADING}\n\nNone.\n`)
  })

  it('lists left-out candidates in their own section, markup from token lists neutralised', () => {
    const d = decideRefresh({ chainId: 1, previous, candidate: [...previous, evil], audit: stubAudit(new Set([evil.address.toLowerCase()])), protectedAddresses: new Set(), trustedList: healthy })
    const body = renderPrBodySections(d)
    const leftOutPart = body.slice(body.indexOf(`## ${LEFT_OUT_HEADING}`))
    expect(leftOutPart).toContain(evil.address)
    expect(body.match(/^## /gm)).toHaveLength(2) // the symbol cannot inject a heading
    expect(body).not.toContain('http://evil)')
    expect(body).not.toMatch(/<b>/)
  })

  it('sanitizeInline strips control characters, markup and caps the length', () => {
    expect(sanitizeInline('a\u0000b\nc`d|e<f>')).toBe("a?b?c'd'e'f'")
    expect(sanitizeInline('x'.repeat(500), 50)).toHaveLength(50)
    expect(sanitizeInline('a \u2014 b \u2013 c')).toBe('a - b - c')
  })

  it('blocked summary names the reason, says nothing changed and keeps the attempted lists', () => {
    const d = decideRefresh({ chainId: 1, previous, candidate: previous, audit: stubAudit(new Set(previous.slice(0, 30).map((r) => r.address.toLowerCase()))), protectedAddresses: new Set(), trustedList: healthy })
    const text = renderBlockedSummary(d)
    expect(text).toContain('removal-cap')
    expect(text).toContain('Nothing was changed')
    expect(text).toContain('Removals the refresh would have made (30)')
    expect(renderBlockedSummary(decideRefresh({ chainId: 1, previous, candidate: previous, audit: stubAudit(new Set()), protectedAddresses: new Set(), trustedList: healthy }))).toBe('')
  })
})
