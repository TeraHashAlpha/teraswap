// @vitest-environment node
/**
 * The three places where the state machine raises an alert (kv-store-failure, state transition, probe-infra-failure)
 * each hand the promise to the keep-alive hook instead of leaving it bare. The machine still decides synchronously and
 * never waits for the alert; a failing alert never throws into the caller and never changes a state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
