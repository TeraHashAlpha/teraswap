// @vitest-environment node
/**
 * The three places where the state machine raises an alert (kv-store-failure, state transition, probe-infra-failure)
 * each hand the promise to the keep-alive hook instead of leaving it bare. The machine still decides synchronously and
 * never waits for the alert; a failing alert never throws into the caller and never changes a state.
 *
 * [fix/flaky-tests-root-cause] alert-inflight.ts loads `after` lazily: its `import('next/server')` starts when the module is
 * evaluated and finishes later. In a production build that import is a microtask (Turbopack compiles it to
 * `Promise.resolve().then(() => require(...))`), so the hook is in place before any request can reach a state change. Here it
 * is this file's mock factory, which loads the real next/server from disk: ~15 ms idle, more on a loaded runner, while the first
 * test raises its alert ~10 ms after that import starts. Until it finishes, trackAlert hands the alert over on its late path
 * (alert-inflight.ts handToAfter), i.e. after the synchronous assertions below: CI 2026-11-17 18:28 UTC, `afterMock` 0 calls in
 * the 5 tests that read it. So the tests first wait until the hook is in place, as it is in production before a request, and the
 * last block pins both orders (hook first / alert first) on every alert site. The waits are event-driven: a probe alert is handed
 * over and the wait ends when THIS file's mock receives it (at once if the hook is loaded, else when the load completes).
 * `vi.dynamicImportSettled()` was tried first and is not enough: under load it returned before the hook was in place (2/40 runs).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

const kvStore = new Map<string, unknown>()
const kvSets = new Set<string>()
const kvFlags = vi.hoisted(() => ({ failWrites: false }))
vi.mock('@/lib/kv', () => ({
  kv: {
    get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { kvStore.set(key, value) }),
    smembers: vi.fn(async () => Array.from(kvSets)),
    pipeline: () => {
      const p = {
        set: (key: string, value: unknown) => { kvStore.set(key, value); return p },
        sadd: (_key: string, id: string) => { kvSets.add(id); return p },
        del: () => p,
        exec: async () => { if (kvFlags.failWrites) throw new Error('upstash down'); return [] },
      }
      return p
    },
  },
}))

const emit = vi.hoisted(() => vi.fn())
vi.mock('./alert-wrapper', () => ({ emitTransitionAlert: (...a: unknown[]) => emit(...a) }))

const afterMock = vi.hoisted(() => vi.fn())
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: afterMock,
}))

import { forceDisable, recordHealthCheck, recordRateLimited, getStatus, beginTick } from './source-state-machine'
import { trackAlert } from './alert-inflight' // the same instance the state machine imports

/** Resolves with the task when this file's `after` mock receives its next hand-over. */
function nextHandOver(): Promise<unknown> {
  return new Promise((resolve) => { afterMock.mockImplementationOnce((task: unknown) => { resolve(task) }) })
}

/** Wait until `track` reaches this file's hook: a probe goes in, the wait ends when the mock receives it. */
async function hookInPlace(track: (p: Promise<unknown>) => void): Promise<void> {
  const received = nextHandOver()
  track(Promise.resolve())
  await received // never resolves if the module is bound to any other `after`: the hook then fails, which is the point
  afterMock.mockReset()
}

beforeAll(() => hookInPlace(trackAlert))

/** An alert whose delivery completes when the test says so. */
function controllable() {
  let finish!: () => void
  const promise = new Promise<void>((resolve) => { finish = resolve })
  return { promise, finish }
}

/** True once `p` has settled (a macrotask turn flushes the whole promise chain). */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false
  void p.then(() => { done = true }, () => { done = true })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  return done
}

describe('source-state-machine hands every alert promise to the keep-alive hook', () => {
  beforeEach(() => {
    kvStore.clear()
    kvSets.clear()
    kvFlags.failWrites = false
    beginTick()
    emit.mockReset().mockResolvedValue(undefined)
    afterMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('state transition: one alert, handed to the hook; the caller does not wait for it', async () => {
    const alert = controllable()
    emit.mockReturnValue(alert.promise)
    await forceDisable('openocean', 'operator-disable: test') // resolves although the alert is still in flight

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('openocean', 'active', 'disabled', 'force: operator-disable: test')
    expect(afterMock).toHaveBeenCalledTimes(1)
    const handed = afterMock.mock.calls[0][0] as Promise<unknown>
    expect(await settled(handed)).toBe(false) // the hook holds the alert open...
    alert.finish()
    expect(await settled(handed)).toBe(true) // ...until it is delivered
    expect((await getStatus('openocean')).state).toBe('disabled')
  })

  it('kv-store-failure: the P0 alert about a broken state store is handed to the hook too', async () => {
    kvFlags.failWrites = true
    // A 429 degrade is a quiet transition (no alert of its own), so the write failure is the only alert here.
    await recordRateLimited('cowswap', 'probe')

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toBe('cowswap')
    expect(String(emit.mock.calls[0][3])).toMatch(/^kv-store-failure: write — upstash down/)
    expect(afterMock).toHaveBeenCalledTimes(1)
  })

  it('probe-infra-failure: the 10th consecutive probe error raises ONE alert, handed to the hook; 1-9 raise none', async () => {
    const infra = { ok: false, latencyMs: 0, error: 'probe timeout', kind: 'infra' } as const
    for (let i = 1; i <= 9; i++) {
      beginTick()
      await recordHealthCheck('uniswapv3', infra)
    }
    expect(emit).not.toHaveBeenCalled()
    expect(afterMock).not.toHaveBeenCalled()

    beginTick()
    await recordHealthCheck('uniswapv3', infra)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(String(emit.mock.calls[0][3])).toMatch(/^probe-infra-failure: 10 consecutive probe errors/)
    expect(afterMock).toHaveBeenCalledTimes(1)

    beginTick()
    await recordHealthCheck('uniswapv3', infra) // the 11th: still silent
    expect(emit).toHaveBeenCalledTimes(1)
    expect(afterMock).toHaveBeenCalledTimes(1)
  })

  it('a failing alert never throws into the caller, never changes the state, and is logged once', async () => {
    emit.mockRejectedValue(new Error('telegram, email and discord all failed'))
    await expect(forceDisable('openocean', 'operator-disable: test')).resolves.toBeUndefined()

    expect((await getStatus('openocean')).state).toBe('disabled')
    const handed = afterMock.mock.calls[0][0] as Promise<unknown>
    await expect(handed).resolves.toBeUndefined() // the hook never sees a rejection
    const lines = vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(' '))
    expect(lines.filter((l) => l.includes('alert emission failed for'))).toHaveLength(1)
  })

  it('a hook that throws (no request scope) changes nothing: the state is written and the alert still runs', async () => {
    afterMock.mockImplementation(() => { throw new Error('`after` was called outside a request scope.') })
    await expect(forceDisable('openocean', 'operator-disable: test')).resolves.toBeUndefined()
    expect(emit).toHaveBeenCalledTimes(1)
    expect((await getStatus('openocean')).state).toBe('disabled')
  })

  it('no duplicate: one transition raises one alert and one hand-over; repeating it raises none', async () => {
    await forceDisable('openocean', 'operator-disable: test')
    await forceDisable('openocean', 'operator-disable: test') // already disabled: transition() is a no-op
    expect(emit).toHaveBeenCalledTimes(1)
    expect(afterMock).toHaveBeenCalledTimes(1)
  })
})

// Kept last: it swaps the `next/server` mock for a gated one and loads fresh module instances.
describe('the hand-over does not depend on when the keep-alive hook finishes loading', () => {
  type Machine = typeof import('./source-state-machine')
  const SITES: Array<[string, (m: Machine) => Promise<void>]> = [
    ['state transition', (m) => m.forceDisable('openocean', 'operator-disable: test')],
    ['kv-store-failure', async (m) => { kvFlags.failWrites = true; await m.recordRateLimited('cowswap', 'probe') }],
    ['probe-infra-failure', async (m) => {
      for (let i = 1; i <= 10; i++) {
        m.beginTick()
        await m.recordHealthCheck('uniswapv3', { ok: false, latencyMs: 0, error: 'probe timeout', kind: 'infra' })
      }
    }],
  ]

  beforeEach(() => {
    kvStore.clear()
    kvSets.clear()
    kvFlags.failWrites = false
    emit.mockReset().mockResolvedValue(undefined)
    afterMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  for (const [site, raise] of SITES) {
    for (const order of ['hook loaded first', 'alert raised first'] as const) {
      it(`${site}, ${order}: exactly one hand-over, to this file's hook`, async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        vi.resetModules()
        vi.doMock('next/server', async () => { await gate; return { after: afterMock } })
        const m = await import('./source-state-machine') // fresh alert-inflight: its hook load now waits on `gate`
        const inflight = await import('./alert-inflight') // that same fresh instance
        m.beginTick()
        if (order === 'hook loaded first') {
          release()
          await hookInPlace(inflight.trackAlert)
          await raise(m)
          expect(afterMock).toHaveBeenCalledTimes(1) // handed over on the synchronous path, before the caller resumed
        } else {
          const handed = nextHandOver()
          await raise(m)
          expect(afterMock).not.toHaveBeenCalled() // nothing to hand it to yet...
          release()
          await handed // ...so it is handed over as soon as the hook is there
          expect(afterMock).toHaveBeenCalledTimes(1)
        }
        expect(emit).toHaveBeenCalledTimes(1)
        expect(afterMock.mock.calls[0][0]).toBeInstanceOf(Promise)
      })
    }
  }
})
