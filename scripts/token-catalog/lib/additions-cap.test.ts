/**
 * [fix/catalog-refresh-drops-untrusted] Rule B — the weekly additions cap — as units: ranking, ties, the size-bound
 * clamp, protected tokens, a blocked decision, the PR-body sections. The end-to-end and seeded cases are in
 * growth-and-cap.test.ts. No network.
 */
import { describe, it, expect } from 'vitest'
import type { CatalogRow, GuardOutcome } from './types'
import {
  HELD_CANDIDATES_HEADING,
  HELD_SOURCES_HEADING,
  MAX_ADDITIONS_PER_CHAIN,
  additionsAllowed,
  applyAdditionsCap,
  cappableAdditions,
  compareCandidates,
  decideRefresh,
  renderBlockedSummary,
  renderHeldBackIssueBody,
  renderPrBodySections,
  type RefreshDecision,
} from './refresh-decision'

const hex = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`
const row = (n: number, over: Partial<CatalogRow> = {}): CatalogRow =>
  ({ address: hex(n), symbol: `T${n}`, name: `Token ${n}`, decimals: 18, category: 'Other', logoURI: '/x', verified: true, sources: ['uniswap', 'coingecko'], volume24hUsd: null, volumeSource: null, volumeFetchedAt: null, ...over }) as CatalogRow
const passAll = (rows: readonly CatalogRow[]): ReadonlyMap<string, GuardOutcome> => new Map(rows.map((r) => [r.address.toLowerCase(), { status: 'pass' as const }]))
const vols = (entries: Array<[number, number | null]>) => new Map(entries.map(([n, v]) => [hex(n).toLowerCase(), v]))

/** previous = rows 100000..100000+prev-1; the candidate catalog = previous + `adds` new rows 1000..1000+adds-1 */
function scenario(prev: number, adds: number) {
  const previous = Array.from({ length: prev }, (_, i) => row(100000 + i))
  const added = Array.from({ length: adds }, (_, i) => row(1000 + i))
  const decision = decideRefresh({ chainId: 1, previous, candidate: [...previous, ...added], audit: passAll, protectedAddresses: new Set(), trustedList: { previous: 100, current: 99 } })
  return { previous, added, decision }
}
const newRows = (d: RefreshDecision, _prev: number) => d.catalog.filter((r) => Number(BigInt(r.address)) < 100000)

describe('applyAdditionsCap', () => {
  it('26 candidates, cap 25: the lowest 7-day volume is the one held back', () => {
    const { previous, decision } = scenario(50, 26)
    const volume7d = new Map(Array.from({ length: 26 }, (_, i) => [hex(1000 + i).toLowerCase(), 100 + i * 10] as const))
    volume7d.set(hex(1013).toLowerCase(), 5) // the lowest
    const r = applyAdditionsCap(decision, { previous, protectedAddresses: new Set(), volume7d, audit: passAll })
    expect(newRows(r, 50)).toHaveLength(MAX_ADDITIONS_PER_CHAIN)
    expect(r.heldBack.map((l) => l.address)).toEqual([hex(1013)])
    expect(r.heldBack[0].why).toMatch(/^weekly cap: at most 25 additions per chain/)
    expect(r.catalog).toHaveLength(75)
  })

  it('exactly 25 candidates and fewer are untouched (same object)', () => {
    for (const adds of [0, 1, 24, 25]) {
      const { previous, decision } = scenario(50, adds)
      expect(applyAdditionsCap(decision, { previous, protectedAddresses: new Set(), volume7d: new Map(), audit: passAll })).toBe(decision)
    }
  })

  it('ranks by 7-day volume, descending; an unknown volume ranks after every known one', () => {
    const { previous, decision } = scenario(10, 6)
    const volume7d = vols([[1000, 50], [1001, null], [1002, 900], [1003, 10], [1004, 300], [1005, 700]])
    const r = applyAdditionsCap(decision, { previous, protectedAddresses: new Set(), volume7d, maxAdditions: 3, audit: passAll })
    expect(newRows(r, 10).map((x) => x.address)).toEqual([hex(1002), hex(1004), hex(1005)])
    expect(r.heldBack.map((l) => l.address)).toEqual([hex(1000), hex(1003), hex(1001)]) // 50, 10, then unknown last
  })

  it('equal 7-day volume falls back to 24h volume, then symbol, then address — a total order, same result every time', () => {
    const a = row(1000, { volume24hUsd: 5, symbol: 'B' })
    const b = row(1001, { volume24hUsd: 9, symbol: 'A' })
    const c = row(1002, { volume24hUsd: 5, symbol: 'A' })
    const d = row(1003, { volume24hUsd: 5, symbol: 'A' })
    const none = new Map<string, number | null>()
    const sorted = [a, b, c, d].sort((x, y) => compareCandidates(x, y, none)).map((r) => r.address)
    expect(sorted).toEqual([b.address, c.address, d.address, a.address]) // 24h 9; then 24h 5 by symbol A (address order c, d) then B
    expect([d, c, b, a].sort((x, y) => compareCandidates(x, y, none)).map((r) => r.address)).toEqual(sorted)
  })

  it('the size bound clamps the cap: room under `< bound`, never negative, and the reason says so', () => {
    const { previous, decision } = scenario(994, 40)
    const volume7d = new Map(Array.from({ length: 40 }, (_, i) => [hex(1000 + i).toLowerCase(), i + 1] as const))
    const r = applyAdditionsCap(decision, { previous, protectedAddresses: new Set(), volume7d, sizeBound: 1000, audit: passAll })
    expect(r.catalog).toHaveLength(999)
    expect(newRows(r, 994)).toHaveLength(5)
    expect(r.heldBack).toHaveLength(35)
    expect(r.heldBack[0].why).toMatch(/^size bound: the catalog must stay under 1000 rows \(room for 5 addition\(s\) this week\)/)
    // the five kept are the five highest volumes
    expect(newRows(r, 994).map((x) => x.address).sort()).toEqual([1035, 1036, 1037, 1038, 1039].map(hex).sort())
    // a chain already at the bound gets no additions at all
    const full = scenario(1000, 3)
    const none = applyAdditionsCap(full.decision, { previous: full.previous, protectedAddresses: new Set(), volume7d: new Map(), sizeBound: 1000, audit: passAll })
    expect(none.catalog).toHaveLength(1000)
    expect(none.heldBack).toHaveLength(3)
  })

  it('a bound with more room than the cap leaves the cap in charge', () => {
    const { previous, decision } = scenario(100, 30)
    expect(additionsAllowed(decision, { previous, protectedAddresses: new Set(), sizeBound: 500 })).toEqual({ allowed: 25, limitedBy: 'weekly-cap' })
    expect(additionsAllowed(decision, { previous, protectedAddresses: new Set(), sizeBound: 120 })).toEqual({ allowed: 19, limitedBy: 'size-bound' })
  })

  it('a protected (core / hand-pinned) addition is never held back, but it uses up size room', () => {
    const { previous, decision } = scenario(994, 10)
    const protectedAddresses = new Set([hex(1000).toLowerCase()])
    expect(cappableAdditions(decision, previous, protectedAddresses)).toHaveLength(9)
    // volume7d says the protected one is the WORST candidate: it still stays
    const volume7d = new Map(Array.from({ length: 10 }, (_, i) => [hex(1000 + i).toLowerCase(), i === 0 ? 1 : 100 + i] as const))
    const r = applyAdditionsCap(decision, { previous, protectedAddresses, volume7d, sizeBound: 1000, audit: passAll })
    expect(r.catalog.some((x) => x.address === hex(1000))).toBe(true)
    expect(r.catalog).toHaveLength(999) // 994 + 1 protected + 4 others (5 of room, 1 used)
  })

  it('a blocked decision is returned as it is', () => {
    const { previous, added } = scenario(50, 30)
    const blocked = decideRefresh({ chainId: 1, previous, candidate: [...previous, ...added], audit: passAll, protectedAddresses: new Set(), trustedList: { previous: 100, current: 10 } })
    expect(blocked.blocked?.reason).toBe('trusted-list-dead')
    expect(applyAdditionsCap(blocked, { previous, protectedAddresses: new Set(), volume7d: new Map(), audit: passAll })).toBe(blocked)
  })

  it('the capped catalog is audited once more: a fatal that survives blocks the chain and changes nothing', () => {
    const { previous, decision } = scenario(50, 30)
    const bad = (rows: readonly CatalogRow[]): ReadonlyMap<string, GuardOutcome> =>
      new Map(rows.map((r) => [r.address.toLowerCase(), r.address === hex(100005) ? { status: 'fatal' as const, detail: 'stub' } : { status: 'pass' as const }]))
    const r = applyAdditionsCap(decision, { previous, protectedAddresses: new Set(), volume7d: new Map(), audit: bad })
    expect(r.blocked?.reason).toBe('residual-fatal')
    expect(r.catalog).toEqual(previous)
    expect(r.heldBack).toEqual([])
  })
})

describe('PR body + issue text for rules A and B', () => {
  const held = [{ chainId: 42161, source: 'oneinch' as const, previous: 137, current: 5069, baseline: 137 }]
  it('both new sections are always present ("None." when empty), after the two decision sections', () => {
    const { decision } = scenario(10, 0)
    const body = renderPrBodySections(decision)
    const order = ['## Tokens removed from the site by this refresh', '## Candidates left out', `## ${HELD_SOURCES_HEADING}`, `## ${HELD_CANDIDATES_HEADING}`].map((h) => body.indexOf(h))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(body.match(/None\./g)).toHaveLength(4)
  })
  it('a held source lists chain, source, old and new size, the growth and the exact line to commit', () => {
    const { previous, added } = scenario(10, 2)
    const d = decideRefresh({ chainId: 42161, previous, candidate: [...previous, ...added], audit: passAll, protectedAddresses: new Set(), trustedList: { previous: 100, current: 99 }, heldBackSources: held })
    const body = renderPrBodySections(d)
    expect(body).toContain('- chain 42161 · `oneinch` · previous 137 → now 5069 entries (+3600%) · accept with `"42161:oneinch": 5069`')
    expect(body).toContain('scripts/token-catalog/accepted-source-sizes.json')
  })
  it('a source held back is still reported when the chain is blocked', () => {
    const { previous, added } = scenario(10, 2)
    const d = decideRefresh({ chainId: 1, previous, candidate: [...previous, ...added], audit: passAll, protectedAddresses: new Set(), trustedList: { previous: 100, current: 1 }, heldBackSources: held })
    expect(d.blocked).not.toBeNull()
    expect(d.heldBackSources).toEqual(held)
    expect(renderBlockedSummary(d)).toContain('BLOCKED')
  })
  it('held-back candidates are listed with the reason and the 7-day volume (n/a when unknown)', () => {
    const { previous, decision } = scenario(50, 27)
    const volume7d = new Map(Array.from({ length: 27 }, (_, i) => [hex(1000 + i).toLowerCase(), i === 0 ? null : 1000 + i] as const))
    const r = applyAdditionsCap(decision, { previous, protectedAddresses: new Set(), volume7d, audit: passAll })
    const body = renderPrBodySections(r, new Map([...volume7d].map(([k, v]) => [k, v])))
    const sec = body.split(`## ${HELD_CANDIDATES_HEADING}`)[1]
    expect(sec).toContain('2 new token(s) were kept off the site this week')
    expect(sec).toContain('weekly cap: at most 25 additions per chain')
    expect(sec).toMatch(/`T1000`[^\n]*7-day volume n\/a/)
  })
  it('the issue body names source, chain, sizes and the line to commit; it is empty when nothing is held', () => {
    const body = renderHeldBackIssueBody(42161, held, 'https://github.com/x/y/actions/runs/1')
    expect(body).toContain('**chain 42161**')
    expect(body).toContain('previous 137 → now 5069')
    expect(body).toContain('"42161:oneinch": 5069')
    expect(body).toContain('accepted-source-sizes.json')
    expect(renderHeldBackIssueBody(1, [], 'u')).toBe('')
  })
})
