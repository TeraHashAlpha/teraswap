// @vitest-environment node
/**
 * [fix/log-routes-bounded-input, SEC-3] The authenticated GET /api/monitor run over a store polluted the way the audit of
 * 2026-11-17 polluted it: 20,000 invented names in the known-sources set (with the known-quoting flags the old code
 * wrote for them) and in the stored quote rows.
 *
 * Each run issues at most SOURCE_HEALTH_MAX_KV_COMMANDS key-value commands; the invented names in the set shrink on
 * every run (by at least KNOWN_SOURCES_PRUNE_SAMPLE minus the registry size) until none is left, and stay at zero; the
 * registry members are never removed; no alert and no response row carries an invented name.
 *
 * The fake store keeps every value as raw text. Its `kv` replies are parsed the way @upstash/redis parses them by
 * default (JSON, numbers kept as text when they would change), its `kvRaw` replies are not: the set holds members such
 * as "true", "\"x\"" and " 7" that only the raw client can hand back to SREM unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/kv', async () => {
  const { fakeUpstash } = await import('@/test-utils/fake-upstash-kv')
  return { kv: fakeUpstash.kv, kvRaw: fakeUpstash.kvRaw }
})

const emitted = vi.hoisted(() => [] as unknown[][])
vi.mock('@/lib/alert-wrapper', () => ({
  emitTransitionAlert: async (...a: unknown[]) => {
    emitted.push(a)
  },
}))

const quoteRows = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('@/lib/supabase', () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'order', 'limit', 'eq', 'gte']) c[m] = () => c
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === 'quotes' ? quoteRows : [], error: null })
    return c
  }
  return { getSupabase: () => ({ from: chain }) }
})

import { GET } from './route'
import { fakeUpstash } from '@/test-utils/fake-upstash-kv'
import { ADAPTER_SOURCE_NAMES } from '@/lib/adapters'
import { KNOWN_SOURCES_PRUNE_SAMPLE, SOURCE_HEALTH_MAX_KV_COMMANDS } from '@/lib/source-health-monitor'

const SET_KEY = 'teraswap:source-health:known-sources'
const POLLUTED = 20_000
const REGISTRY: readonly string[] = ADAPTER_SOURCE_NAMES
const SECRET = 'test-monitor-secret-0123456789'
const ODD = ['true', 'null', '"x"', ' 7', '1e3', '{"a": 1}', '[1, 2]', '__proto__', 'constructor', '']

function invented(i: number) {
  return i < ODD.length ? ODD[i] : `made-up-${i}`
}
const outsideRegistry = () => [...(fakeUpstash.sets.get(SET_KEY) ?? [])].filter((m) => !REGISTRY.includes(m))

function run() {
  return GET(new Request('http://localhost/api/monitor', { headers: { authorization: `Bearer ${SECRET}` } }))
}

beforeEach(() => {
  vi.stubEnv('MONITOR_SECRET', SECRET)
  fakeUpstash.reset()
  emitted.length = 0
  quoteRows.length = 0
  // The set and the flags the pre-fix monitor wrote for every name it saw, plus five real sources.
  const members = new Set<string>()
  for (let i = 0; i < POLLUTED; i++) {
    members.add(invented(i))
    fakeUpstash.strings.set(`teraswap:source-health:known-quoting:${invented(i)}`, '1')
  }
  for (const name of REGISTRY.slice(0, 5)) members.add(name)
  fakeUpstash.sets.set(SET_KEY, members)
  // Stored quote rows from before the fix: 40 rows of 500 invented names, each also naming the real sources.
  for (let r = 0; r < 40; r++) {
    const names = Array.from({ length: 500 }, (_, i) => invented(r * 500 + i))
    quoteRows.push({
      sources_queried: [...names, ...REGISTRY.slice(0, 5)],
      sources_responded: REGISTRY.slice(0, 5),
      best_source: REGISTRY[r % 5],
      response_time_ms: 300,
    })
  }
})

describe('GET /api/monitor over 20,000 invented names (SEC-3)', () => {
  it('stays under the stated command bound on every run and prunes the set to zero, faster than the stated rate', async () => {
    expect(outsideRegistry()).toHaveLength(POLLUTED)
    const perRun: number[] = []
    const left: number[] = [POLLUTED]
    const minRemovedPerRun = KNOWN_SOURCES_PRUNE_SAMPLE - REGISTRY.length
    const maxRuns = Math.ceil(POLLUTED / minRemovedPerRun)

    for (let i = 0; i < maxRuns + 2; i++) {
      fakeUpstash.calls.length = 0
      const res = await run()
      expect(res.status).toBe(200)
      perRun.push(fakeUpstash.calls.length)
      left.push(outsideRegistry().length)
      const before = left[left.length - 2]
      const after = left[left.length - 1]
      // Every run removes at least min(what is left, SAMPLE - R).
      expect(before - after, `run ${i + 1}`).toBeGreaterThanOrEqual(Math.min(before, minRemovedPerRun))
    }

    expect(Math.max(...perRun)).toBeLessThanOrEqual(SOURCE_HEALTH_MAX_KV_COMMANDS)
    expect(SOURCE_HEALTH_MAX_KV_COMMANDS).toBe(3 + 9 * REGISTRY.length)
    expect(left.findIndex((n) => n === 0)).toBeLessThanOrEqual(maxRuns)
    expect(left.slice(-3)).toEqual([0, 0, 0])
    // The real sources stay members; the JSON-looking members went too (read as raw text, not parsed).
    expect([...(fakeUpstash.sets.get(SET_KEY) ?? [])].sort()).toEqual([...REGISTRY.slice(0, 5)].sort())
  })

  it('reports, records and alerts on registry sources only', async () => {
    const res = await run()
    const json = await res.json()
    const reported = (json.sourceHealth as Array<{ source: string; quoteCount: number }>).map((s) => s.source)
    expect(reported.sort()).toEqual([...REGISTRY.slice(0, 5)].sort())
    for (const row of json.sourceHealth as Array<{ quoteCount: number }>) expect(row.quoteCount).toBe(40)
    for (const f of json.sourceHealthFindings as Array<{ source: string }>) expect(REGISTRY).toContain(f.source)
    for (const call of emitted) expect(REGISTRY).toContain(call[0])
    // Nothing new was written for an invented name.
    const keysWritten = [...fakeUpstash.strings.keys()].filter((k) => k.includes('made-up') && !k.includes('known-quoting'))
    expect(keysWritten).toEqual([])
  })

  it('a silent registry source still alerts (its known-quoting flag and set membership are read)', async () => {
    const silent = REGISTRY[6]
    fakeUpstash.sets.get(SET_KEY)!.add(silent)
    fakeUpstash.strings.set(`teraswap:source-health:known-quoting:${silent}`, '1')
    await run()
    expect(emitted.map((c) => c[0])).toEqual([silent])
    expect(String(emitted[0][3])).toMatch(/SILENT/)
  })
})
