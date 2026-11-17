// @vitest-environment node
/**
 * trackAlert / runWithAlertsSettled: a fire-and-forget alert is kept alive until it settles.
 *  - inside runWithAlertsSettled (the cron tick) it is collected and awaited, bounded;
 *  - outside it, on a request path, it is handed to Next's `after()`;
 *  - outside any request scope it is left as it was (no throw, no unhandled rejection).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

const afterMock = vi.hoisted(() => vi.fn())
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: afterMock,
}))

import { trackAlert, runWithAlertsSettled, ALERT_SETTLE_MAX_MS } from './alert-inflight'

// [fix/flaky-tests-root-cause] `after` is loaded lazily (alert-inflight.ts: `import('next/server')` at module evaluation). Here that
// import is the factory above loading the real next/server, so on a loaded runner it can still be pending when a test expects a
// synchronous hand-over (same cause as source-state-machine.alert-handoff.test.ts). Wait until the hook is in place, as it is in
// production before a request: a probe is handed over and the wait ends when THIS file's mock receives it (at once if loaded, else
// when the load completes). Event-driven; if the module were bound to any other `after` the probe never arrives and this hook fails.
beforeAll(async () => {
  const received = new Promise<void>((resolve) => { afterMock.mockImplementationOnce(() => { resolve() }) })
  trackAlert(Promise.resolve())
  await received
  afterMock.mockReset()
})

/** A promise that settles after `ms` of (fake) time. */
function later(ms: number, settle: 'resolve' | 'reject' = 'resolve'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    setTimeout(() => (settle === 'resolve' ? resolve() : reject(new Error('boom'))), ms)
  })
}

describe('trackAlert / runWithAlertsSettled', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    afterMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('awaits an alert raised inside the run: the run resolves only after it settled', async () => {
    const order: string[] = []
    const run = runWithAlertsSettled(async () => {
      trackAlert(later(3_000).then(() => { order.push('alert') }))
      order.push('work-done')
      return 'result'
    })
    let value: string | undefined
    void run.then((v) => { value = v; order.push('response') })

    await vi.advanceTimersByTimeAsync(2_999)
    expect(value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(value).toBe('result')
    expect(order).toEqual(['work-done', 'alert', 'response'])
    expect(afterMock).not.toHaveBeenCalled() // collected, not handed to the hook: one path per alert
  })

  it('a rejecting alert never throws into the run and never becomes an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const run = runWithAlertsSettled(async () => {
        trackAlert(later(10, 'reject'))
        return 7
      })
      await vi.advanceTimersByTimeAsync(10)
      await expect(run).resolves.toBe(7)
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('settles the alerts caused before a failure, then rethrows the original error', async () => {
    const delivered = vi.fn()
    const run = runWithAlertsSettled(async () => {
      trackAlert(later(2_000).then(delivered))
      throw new Error('tick failed')
    })
    const outcome = run.then(() => 'ok', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(delivered).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(delivered).toHaveBeenCalledTimes(1)
    await expect(outcome).resolves.toBe('tick failed')
  })

  it('an alert that never settles is waited for at most ALERT_SETTLE_MAX_MS, then logged and handed to after()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = runWithAlertsSettled(async () => {
      trackAlert(new Promise<void>(() => {}))
      return 'x'
    })
    let done = false
    void run.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(ALERT_SETTLE_MAX_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 alert(s) still in flight after'))
    expect(afterMock).toHaveBeenCalledTimes(1) // the leftover keeps going until the platform's own limit
  })

  it('never waits past deadlineAt, even when the cap is longer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = runWithAlertsSettled(async () => {
      trackAlert(new Promise<void>(() => {}))
    }, { deadlineAt: Date.now() + 4_000 })
    let done = false
    void run.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(3_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('does not wait at all when the deadline has already passed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let done = false
    void runWithAlertsSettled(async () => {
      trackAlert(new Promise<void>(() => {}))
    }, { deadlineAt: Date.now() - 1 }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('with nothing in flight the run resolves at once and sets no timer', async () => {
    const run = runWithAlertsSettled(async () => 'quiet')
    await expect(run).resolves.toBe('quiet')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('outside a run (a request path) the promise is handed to after() exactly once', async () => {
    const alert = later(1_000)
    trackAlert(alert)
    expect(afterMock).toHaveBeenCalledTimes(1)
    const handed = afterMock.mock.calls[0][0] as Promise<unknown>
    expect(handed).toBeInstanceOf(Promise)
    let settled = false
    void handed.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('outside any request scope after() throws: trackAlert swallows it and the alert still runs', async () => {
    afterMock.mockImplementation(() => { throw new Error('`after` was called outside a request scope.') })
    const delivered = vi.fn()
    expect(() => trackAlert(later(5).then(delivered))).not.toThrow()
    await vi.advanceTimersByTimeAsync(5)
    expect(delivered).toHaveBeenCalledTimes(1)
  })
})
