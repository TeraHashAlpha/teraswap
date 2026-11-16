/**
 * Keeps a fire-and-forget transition alert alive until it settles.
 *
 * Why: `source-state-machine.ts` decides synchronously and hands the alert fan-out to `emitTransitionAlert` without
 * awaiting it (a slow channel must never hold up a state change). On Vercel a function may be frozen as soon as its
 * response is sent, so an alert still in flight was cut: 2026-11-13 13:26, 14:01, 14:28 UTC, "delivery failed for
 * openocean: The operation was aborted due to timeout" and no Telegram message.
 *
 * `trackAlert(promise)` is the ONLY place such a promise goes. It hands it to
 *   1. the collector of the surrounding `runWithAlertsSettled` (the cron tick: nobody waits on it, so it awaits the
 *      alerts it caused, bounded, before it responds), else
 *   2. Next's `after()` (a user-facing route: the reply goes out at once, the platform keeps the function alive until
 *      the alert settles), else
 *   3. nothing (no request scope: a script or a test), which is exactly the old fire-and-forget.
 * It never throws, never rejects, and never changes what the alert says or whom it reaches.
 *
 * @internal — server-only module. Same import restrictions as source-state-machine.ts.
 */

import type { AsyncLocalStorage as AsyncLocalStorageType } from 'node:async_hooks'

// `after` is loaded lazily, never by a static `import { after } from 'next/server'`: this module is reachable from a client
// bundle (adapters/circuit-breaker.ts imports the state machine dynamically), and Next refuses a static `after` import there
// ("only available in Server Components"). On the server the load below finishes at module init, long before a request.
type AfterFn = (task: Promise<unknown>) => void
let afterFn: AfterFn | undefined
const afterLoaded: Promise<void> = (typeof window !== 'undefined' ? Promise.resolve({ after: undefined }) : import('next/server')).then(
  (m) => { afterFn = m.after as AfterFn | undefined },
  () => { /* no hook available: alerts fall back to plain fire-and-forget */ },
)

/** Hand `task` to Next's `after()`; throws (caller catches) outside a request scope. Falls back to a late load if the hook was not ready yet. */
function handToAfter(task: Promise<unknown>): void {
  if (afterFn) { afterFn(task); return }
  void afterLoaded.then(() => {
    try { afterFn?.(task) } catch { /* no request scope */ }
  })
}

/**
 * Hard cap on how long the tick waits for the alerts it caused. A Telegram send alone is bounded by
 * TELEGRAM_TOTAL_BUDGET_MS (12 000 ms, `alert-channels/telegram.ts`); email and Discord are 5 000 ms and run in parallel;
 * the 3 000 ms left cover the KV round trips in front of the fan-out (grace, dedup get/set).
 */
export const ALERT_SETTLE_MAX_MS = 15_000

interface Collector {
  pending: Set<Promise<void>>
}

// Same reason as `after` above: a static `node:async_hooks` import cannot be bundled into a client chunk, so the module is taken from
// the running Node (22+) at init. Without it (a browser chunk that never runs this) `runWithAlertsSettled` simply runs `fn`.
const asyncHooks = typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
  ? process.getBuiltinModule('node:async_hooks')
  : undefined
const scope: AsyncLocalStorageType<Collector> | undefined = asyncHooks ? new asyncHooks.AsyncLocalStorage<Collector>() : undefined

/** Hand one alert promise to whoever keeps the function alive. Never throws; the promise is never left bare. */
export function trackAlert(alert: Promise<unknown>): void {
  // Callers already .catch and log; this swallow is the belt, so a late rejection can never become an unhandled one.
  const settled: Promise<void> = alert.then(() => undefined, () => undefined)

  const collector = scope?.getStore()
  if (collector) {
    collector.pending.add(settled)
    void settled.then(() => { collector.pending.delete(settled) })
    return
  }

  try {
    handToAfter(settled)
  } catch {
    // Outside a request scope (script, test, module init): nothing to hand it to; it runs as before.
  }
}

export interface AlertSettleOptions {
  /** Longest wait for the alerts (ms). Default ALERT_SETTLE_MAX_MS. */
  maxWaitMs?: number
  /** Absolute epoch ms by which the response must go out; the wait never reaches past it. */
  deadlineAt?: number
}

/** Wait for the collector, at most `waitMs`. Returns how many alerts were still in flight when it gave up. */
async function settleCollector(collector: Collector, waitMs: number): Promise<number> {
  if (collector.pending.size === 0) return 0
  const all = Promise.allSettled([...collector.pending]).then(() => 'settled' as const)
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<'bound'>((resolve) => {
    timer = setTimeout(() => resolve('bound'), Math.max(0, waitMs))
  })
  try {
    const winner = await Promise.race([all, bound])
    return winner === 'settled' ? 0 : collector.pending.size
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Run `fn`; every alert it causes through `trackAlert` is awaited (bounded) before this resolves or rethrows. For a
 * cron route only: the caller is not waiting on the response, so the wait costs nobody anything. The wait is
 * min(maxWaitMs, time left to deadlineAt); alerts still in flight after it are handed to `after()` so they keep going
 * until the platform's own `maxDuration`.
 */
export async function runWithAlertsSettled<T>(fn: () => Promise<T>, opts: AlertSettleOptions = {}): Promise<T> {
  const collector: Collector = { pending: new Set() }
  try {
    return await (scope ? scope.run(collector, fn) : fn())
  } finally {
    const maxWait = opts.maxWaitMs ?? ALERT_SETTLE_MAX_MS
    const left = opts.deadlineAt === undefined ? maxWait : opts.deadlineAt - Date.now()
    const waitMs = Math.max(0, Math.min(maxWait, left))
    const startedAt = Date.now()
    const stillInFlight = await settleCollector(collector, waitMs)
    if (stillInFlight > 0) {
      console.warn(`[ALERT] ${stillInFlight} alert(s) still in flight after ${Date.now() - startedAt}ms — responding anyway`)
      try {
        handToAfter(Promise.allSettled([...collector.pending]))
      } catch {
        // No request scope: nothing more to do.
      }
    }
  }
}
