// @vitest-environment node
/**
 * [fix/log-routes-bounded-input, SEC-3] source-health-monitor reads, writes and alerts on adapter-registry sources only,
 * and prunes other names from the known-sources set, a bounded number per run. The route-level run over 20,000 invented
 * names is app/api/monitor/route.sec3.test.ts; this file pins the module's own entry points on the same fake store.
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

import { fakeUpstash } from '@/test-utils/fake-upstash-kv'
import { ADAPTER_SOURCE_NAMES } from '@/lib/adapters'
import {
  checkSourceHealthAlerts,
  pruneUnregisteredKnownSources,
  recordQuoteDisplayDrop,
  KNOWN_SOURCES_PRUNE_SAMPLE,
  OUTLIER_DROP_ALERT_THRESHOLD,
  SOURCE_HEALTH_MAX_KV_COMMANDS,
} from './source-health-monitor'

const SET_KEY = 'teraswap:source-health:known-sources'
const DROP = 'teraswap:source-health:display-drop:'
const STREAK = 'teraswap:source-health:zero-win-streak:'
const QUOTING = 'teraswap:source-health:known-quoting:'

beforeEach(() => {
  fakeUpstash.reset()
  emitted.length = 0
})

describe('recordQuoteDisplayDrop', () => {
  it('issues no command for a name outside the registry', async () => {
    await recordQuoteDisplayDrop('made-up')
    await recordQuoteDisplayDrop('__proto__')
    expect(fakeUpstash.calls).toEqual([])
  })

  it('still counts a registry source (INCR, then EXPIRE on the first write)', async () => {
    await recordQuoteDisplayDrop('openocean')
    expect(fakeUpstash.calls).toEqual(['incr', 'expire'])
  })
})

describe('checkSourceHealthAlerts with invented names that would have met every detector', () => {
  it('reads, writes and alerts on registry sources only, within the command bound', async () => {
    // Pre-fix state for two invented names: in the set, flagged as quoting, a zero-win streak, display drops.
    for (const name of ['made-up-a', 'made-up-b']) {
      fakeUpstash.sets.set(SET_KEY, new Set([...(fakeUpstash.sets.get(SET_KEY) ?? []), name]))
      fakeUpstash.strings.set(`${QUOTING}${name}`, '1')
      fakeUpstash.strings.set(`${STREAK}${name}`, '5')
      fakeUpstash.strings.set(`${DROP}${name}`, String(OUTLIER_DROP_ALERT_THRESHOLD * 3))
    }
    // One real source with the same display-drop count: it must still alert.
    fakeUpstash.strings.set(`${DROP}velora`, String(OUTLIER_DROP_ALERT_THRESHOLD))

    const findings = await checkSourceHealthAlerts([
      { source: 'made-up-a', quoteCount: 500, winCount: 0 }, // drift + outlier before the fix
      { source: 'velora', quoteCount: 100, winCount: 10 },
    ])

    expect(findings.map((f) => `${f.source}:${f.kind}`)).toEqual(['velora:outlier'])
    expect(emitted.map((c) => c[0])).toEqual(['velora'])
    expect(fakeUpstash.calls.length).toBeLessThanOrEqual(SOURCE_HEALTH_MAX_KV_COMMANDS)
    // Nothing was written for an invented name, and the prune took both out of the set.
    expect(fakeUpstash.strings.get(`${STREAK}made-up-a`)).toBe('5')
    expect([...(fakeUpstash.sets.get(SET_KEY) ?? [])]).toEqual(['velora'])
  })

  it('issues the same number of commands whether the set holds 0 or 5,000 invented names', async () => {
    const snapshots = ADAPTER_SOURCE_NAMES.map((source) => ({ source, quoteCount: 30, winCount: 1 }))
    await checkSourceHealthAlerts(snapshots)
    const clean = fakeUpstash.calls.length

    fakeUpstash.reset()
    fakeUpstash.sets.set(SET_KEY, new Set(Array.from({ length: 5000 }, (_, i) => `made-up-${i}`)))
    await checkSourceHealthAlerts([...snapshots, ...Array.from({ length: 5000 }, (_, i) => ({ source: `made-up-${i}`, quoteCount: 30, winCount: 0 }))])
    // Polluted: + one SREM (the prune's SRANDMEMBER runs in both).
    expect(fakeUpstash.calls.length).toBe(clean + 1)
    expect(fakeUpstash.calls.length).toBeLessThanOrEqual(SOURCE_HEALTH_MAX_KV_COMMANDS)
  })
})

describe('pruneUnregisteredKnownSources', () => {
  it('removes at most KNOWN_SOURCES_PRUNE_SAMPLE names per run, in two commands, never a registry name', async () => {
    const junk = Array.from({ length: 1200 }, (_, i) => `made-up-${i}`)
    fakeUpstash.sets.set(SET_KEY, new Set([...junk, ...ADAPTER_SOURCE_NAMES]))
    const removed = await pruneUnregisteredKnownSources()
    expect(fakeUpstash.calls).toEqual(['srandmember', 'srem'])
    expect(removed).toBeLessThanOrEqual(KNOWN_SOURCES_PRUNE_SAMPLE)
    expect(removed).toBeGreaterThanOrEqual(KNOWN_SOURCES_PRUNE_SAMPLE - ADAPTER_SOURCE_NAMES.length)
    for (const name of ADAPTER_SOURCE_NAMES) expect(fakeUpstash.sets.get(SET_KEY)!.has(name)).toBe(true)
  })

  it('removes members whose text the parsing client would change ("true", "\\"x\\"", " 7", "{\\"a\\": 1}")', async () => {
    const odd = ['true', 'null', '"x"', ' 7', '1e3', '{"a": 1}', '[1, 2]', '']
    fakeUpstash.sets.set(SET_KEY, new Set([...odd, 'velora']))
    // Through the parsing client these come back changed, which is why the prune reads them raw:
    const parsed = await fakeUpstash.kv.srandmember(SET_KEY, 100)
    expect(parsed).toEqual(expect.arrayContaining([true, null, 'x', { a: 1 }, [1, 2]]))

    expect(await pruneUnregisteredKnownSources()).toBe(odd.length)
    expect([...fakeUpstash.sets.get(SET_KEY)!]).toEqual(['velora'])
  })

  it('issues one command and removes nothing when only registry names are left', async () => {
    fakeUpstash.sets.set(SET_KEY, new Set(ADAPTER_SOURCE_NAMES))
    expect(await pruneUnregisteredKnownSources()).toBe(0)
    expect(fakeUpstash.calls).toEqual(['srandmember'])
  })

  it('fails open when the store is unreachable', async () => {
    const spy = vi.spyOn(fakeUpstash.kvRaw, 'srandmember').mockRejectedValueOnce(new Error('kv down'))
    await expect(pruneUnregisteredKnownSources()).resolves.toBe(0)
    spy.mockRestore()
  })
})
