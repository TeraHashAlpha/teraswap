# Feedback — fix/alerts-not-dropped-on-freeze

Base origin/main b47ca15e (PR #687 `chore/tooling-leftovers-2026-11` is on main: the Telegram retry is in `telegram.ts`). No PR (owner opens it).
This file is edited as the work goes; the last edit is the final evidence.

## Checklist
- [x] Gate: retry on main (PR #687, `d18b4118 fix(alerts): one bounded retry for Telegram delivery` is an ancestor of origin/main)
- [x] Premise check + request paths (evidence 1, below)
- [x] Commit 1 (`a11946e2`): no alert left in flight when the response is sent
- [x] Commit 2 (`7f68fcb8`): tests
- [x] Build fix (`da7dcddf`), found by verify: see 5
- [x] Verify (`scripts/agent-verify.sh --codeql`, `node scripts/gen-claude-state.mjs --check`)
- [x] Branch pushed, compare link: see 6

## 1. Premise check and request paths (measured at b47ca15e)

Premise CONFIRMED: `src/lib/source-state-machine.ts` calls `emitTransitionAlert(...)` three times, none awaited, each with only a `.catch`:
`:274` (`alertKVFailure`, reason `kv-store-failure`), `:303` (`transition`), `:351` (`recordHealthCheck`, reason `probe-infra-failure`).
Every other caller in `src/` awaits it (`circuit-breaker.ts:168`, `cow-fee-monitor.ts:58`, `keeper-health-monitor.ts:328/342/351`,
`on-chain-monitor.ts:532/538`, `post-execution-validator.ts:352`, `source-health-monitor.ts:328`, `rate-limit-watch.ts:72/86` via `deps.emit`).

Which entry points reach which site (`grep` of every export that can run `transition` or `saveToKV`; `saveToKV` failing → `:274`):

| Entry point (state machine) | Reaches | Callers in `src` (non-test) |
|---|---|---|
| `recordHealthCheck` | `:303`, `:274`, `:351` | `monitoring-loop.ts:228,240` (tick only) |
| `recordRateLimited` / `clearRateLimited` | `:274` (the 429 degrade is `alert:false`) | `quorum-check.ts:373,374` ← `runQuorumCheck` ← tick only |
| `markRateLimitAlerted` | `:274` | `rate-limit-watch.ts` ← tick only |
| `checkAutoRecovery` | `:303`, `:274` | `monitoring-loop.ts:350` (tick only) |
| `forceDisable` | `:303`, `:274` | tick H2 (`monitoring-loop.ts:281,289`), `quorum-check.ts:475,489` (tick), `admin/kill-switch/route.ts:198`, `telegram/webhook/route.ts:396,456`, `post-execution-validator.ts:345` ← `monitor/validate-execution/route.ts:152` |
| `forceActivate` | `:303`, `:274` | `telegram/webhook/route.ts:429,650` |
| `getStatus` / `getAllStatuses` / `loadFromKV` | none (warn only) | many, incl. `adapters/circuit-breaker.ts:312` |

So the request paths are exactly four: `POST /api/monitor/tick` (cron, nobody waits), `POST /api/admin/kill-switch` (authenticated admin),
`POST /api/telegram/webhook` (Telegram calls it; an operator waits for the bot's reply), `POST /api/monitor/validate-execution`
(`maxDuration = 15`).

**`/api/quote`, `/api/swap`, `/api/v1/quote`, `/api/v1/swap` cannot reach any of the three sites.** They import only `isSystemHalted` from
`circuit-breaker.ts` (a KV read) and the adapters' circuit breaker reads `getAllStatuses`. The goal's "for example /api/quote" is a
conditional ("if it can cause a transition"); it cannot, so no quote path is changed (rate limits, quote results and timing untouched).

Framework hook: Next 16.4.5 exports `after` from `next/server` (`node_modules/next/server.d.ts:21`); stable, no flag in `next.config.js`,
no new dependency. `after()` throws outside a request scope (tests, scripts), which the helper catches.

## 2. What each path does now

One new module, `src/lib/alert-inflight.ts` (no dependency; `next/server`'s `after` + `node:async_hooks`). The three call sites in
`source-state-machine.ts` became `trackAlert(emitTransitionAlert(...).catch(<same log as before>))`; the `.catch` lines, the arguments and the
decision logic are untouched, so which alerts fire, their text, dedup, grace, the retry and every state are as before.

`trackAlert(promise)` hands the promise to exactly one of:
1. **the tick's collector** (inside `runWithAlertsSettled`, an `AsyncLocalStorage` scope) — `/api/monitor/tick` only;
2. **`after()`** — every other request path (`kill-switch`, `telegram/webhook`, `validate-execution`): the reply goes out at once, the platform keeps the
   function alive until the alert settles;
3. nothing, when `after()` throws (no request scope: a script, a test) — exactly the old fire-and-forget.

| Path | Before | Now |
|---|---|---|
| `/api/monitor/tick` | alert in flight when the 200 went out; cut if the function froze | tick work, then waits for its alerts: `min(15 000 ms, 27 000 ms - elapsed)`; leftovers go to `after()`; same on a tick that throws (alerts settled, then 500) |
| `/api/admin/kill-switch`, `/api/telegram/webhook`, `/api/monitor/validate-execution` | same | reply unchanged in time; alert handed to `after()` |
| `/api/quote`, `/api/swap`, `/api/v1/*` | cannot reach the sites | untouched (no diff in those files) |

**Worst case for the tick, every channel hung, retry active** (constants: `CHANNEL_FETCH_TIMEOUT_MS` 5 000, `TELEGRAM_TOTAL_BUDGET_MS` 12 000,
`ALERT_SETTLE_MAX_MS` 15 000, `TICK_RESPONSE_DEADLINE_MS` 27 000 in `tick/route.ts`, `maxDuration` 30 000):
- one alert's fan-out = max(Telegram 12 000 [5 000 + <=2 000 wait + 5 000, attempt 2 shrunk to what is left], email 5 000, Discord 5 000) = **12 000 ms**
  (channels run in parallel). Measured on the real code with fake time: response at **12 000 ms** after the tick's work, 3 "delivery failed" lines.
- before the fan-out `emitTransitionAlert` makes up to 4 KV round trips (grace, grace-end flush, dedup get, dedup get+set). `src/lib/kv.ts` has no timeout, so a
  hung Redis can hold them without limit; that is what the cap is for. Cap case measured: a channel that never answers → response at exactly **15 000 ms**, one
  `1 alert(s) still in flight after 15000ms` warn line, the leftover promise handed to `after()`.
- the wait never reaches past 27 000 ms after the request arrived: a tick whose own work ends at 20 000 ms and whose alert never answers responds at **27 000 ms**
  (3 s margin to `maxDuration`). If the work itself passes 27 000 ms the wait is 0 and the alert goes to `after()`.
- therefore the response is at most `min(work_end + 15 000, 27 000)` ms; it can exceed the 12 000 ms fan-out only when KV is slow, or when a grace-end summary is due
  in the same alert (the summary is a second fan-out in front of the real one: up to 24 000 ms, cut by the cap, rest to `after()`).
- the alerts a tick raises mostly start while the tick is still working (H1 probes), so the wait after the work is normally 0 to a few seconds.

## 3. Tests

New files (all green; 25 tests): `alert-inflight.test.ts` (9: collector awaits, error path, cap, deadline, hook, throwing hook, no unhandled rejection),
`source-state-machine.alert-handoff.test.ts` (6: each of the three sites hands its promise to the hook; a failing alert never throws or changes state;
one transition = one alert + one hand-over), `alert-inflight.guard.test.ts` (4: scanner self-test, no bare `emitTransitionAlert(` in any non-test file under
`src/`, and exactly three calls in the state machine, all `trackAlert(emitTransitionAlert(`; and no static `after` / `node:async_hooks` import in `alert-inflight.ts`), `tick/route.alerts.test.ts` (5, real route + state machine +
wrapper over a fake KV, channels faked with fake time: 3 s channel → delivered then response, one call per channel; all channels time out → 12 000 ms, 3
"delivery failed" lines, state `disabled`; never-answering → 15 000 ms + leftover to `after()`; slow tick → 27 000 ms; throwing tick → waits, then 500),
`kill-switch/route.alert-after.test.ts` (1, real time).

Mutation: with `source-state-machine.ts` put back to origin/main (bare calls) 12 of the 15 new state-machine/route/guard/kill-switch tests fail; the 3 that still
pass are the scanner self-test, "a hook that throws changes nothing" and "all channels time out inside the cap" (true with or without the change, since the
old code responded at once and the logs came later); with the change all 15 pass.

**User-facing path, response time before/after** (`POST /api/admin/kill-switch`, Telegram channel takes 1 000 ms real time): before **3 ms**, the alert never
handed to anything (cut on freeze); after **3 ms**, the alert handed to `after()` once, delivered 1 008 ms later. The test asserts `< 500 ms` and fails if the
route ever awaited the alert.

## 4. Concerns and gaps (not fixed, out of scope)

- `after()` is exercised against a mock of the hook, not a running Next server or Vercel; nothing here proves Vercel keeps a function alive for it. It is the
  framework's documented hook (Next 16.4.5, stable, `next/dist/server/after`).
- `monitoring-loop.ts:366` `void maybeSendWeeklyReport()` is the same bug class (a bare Telegram send, once a week, Sunday 00:xx UTC). Not an
  `emitTransitionAlert`, so not touched; it needs its own goal.
- `validate-execution` raises two alerts for one critical event: `forceDisable` → transition alert (now handed to `after()`), then `handleCritical` awaits its
  own `emitTransitionAlert(source, 'active', 'disabled', ...)`. Pre-existing; dedup counts the second as "2nd occurrence". Unchanged.
- The tick test drives the real state machine from a mocked `runMonitoringTick`, not the real monitoring loop.
- A tick's wait also covers alerts raised by other requests only if they run inside its `AsyncLocalStorage` scope; concurrent requests on the same instance are
  not in it (they use `after()`), so the tick never waits for someone else's alert.

## 5. Build failure found by verify, and the fix (`da7dcddf`)

First verify run (at `7f68fcb8`): everything PASS except **build**. `next build` (Turbopack) refused `alert-inflight.ts`: "You're importing a module that depends on
`after`. This API is only available in Server Components". Cause: `source-state-machine.ts` is reachable from a client chunk through the dynamic import in
`adapters/circuit-breaker.ts:312` (via `adapters/index.ts` -> `product-claims.ts` -> `layout.tsx` / v2 shell), so a static `import { after } from 'next/server'`
lands in a client layer. After lazy-loading `after`, the next error was the same for `node:async_hooks` ("chunking context does not support external modules").
Unit tests could not have caught it. Fix: `after` is imported dynamically at module init (skipped when `window` exists) and `AsyncLocalStorage` is taken from
`process.getBuiltinModule('node:async_hooks')` (Node 22+, the repo's app Node); a guard test keeps both out of static imports. Behaviour is unchanged
(re-run: all 25 new tests + the existing alert suites green).
Residual: `getBuiltinModule` needs Node >= 22.3 (app jobs run Node 22; Vercel runs a newer one). Without it the tick has no collector and its alerts go to `after()`
instead (still kept alive, just not awaited before the response). Wrapping the browser-reachable import is a workaround for the real cause (the state machine is
bundled for the client at all); untangling that is a separate goal.

## 6. Verify (final, at `da7dcddf`, base origin/main `b47ca15e`)

```
suite:       PASS 10845 tests passed, 0 failed, 507 files
lint-delta:  PASS errors +0, warnings +0
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      SKIP not requested
RESULT: PASS
```
`node scripts/gen-claude-state.mjs --check` -> "CLAUDE.md state block is current" (exit 0).

```
 src/app/api/admin/kill-switch/route.alert-after.test.ts | 100 +
 src/app/api/monitor/tick/route.alerts.test.ts           | 199 +
 src/app/api/monitor/tick/route.ts                       |  13 +-
 src/lib/alert-inflight.guard.test.ts                    |  81 +
 src/lib/alert-inflight.test.ts                          | 150 +
 src/lib/alert-inflight.ts                               | 125 +
 src/lib/source-state-machine.alert-handoff.test.ts      | 140 +
 src/lib/source-state-machine.ts                         |  17 +-
 (+ this feedback file)
```
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/alerts-not-dropped-on-freeze (no PR; the owner opens it; Auditor recommended: this touches the alert path).

## 7. Reads from the goal's list that were first only grepped or skimmed (read in full afterwards)

The first pass only grepped `next.config.js`, `alert-channels/email.ts`, `discord.ts`, `status.ts`, `telegram-retry.test.ts`, `telegram.test.ts`, the second half of
`tick/route.test.ts`, and read part of `source-state-machine.rate-limit.test.ts` and `.recovery.test.ts`. All were read in full afterwards. What they show:

- `next.config.js`: no `experimental` block and no function-duration setting; `after()` needs no flag on Next 16.4.5. `webpack()` is ignored by Turbopack, and Sentry wraps
  the config (`withSentryConfig`); neither touches `after()`. Nothing to change.
- `email.ts`, `discord.ts`: one attempt each, `AbortSignal.timeout(CHANNEL_FETCH_TIMEOUT_MS)` = 5 000 ms, no retry; they throw `Resend API <status>: <body>` /
  `Discord webhook <status>: <body>`. This confirms the fan-out bound of 12 000 ms (Telegram) vs 5 000 ms (email, Discord), in parallel. Unconfigured or invalid channels
  warn and return at once. Concern, not changed: only Telegram scrubs its token from errors; the Resend key and the Discord webhook URL are not in these messages today
  (the key is only in a header, the URL only in `fetch`), but a transport error that quotes a URL would not be scrubbed on those two channels.
- `status.ts` (+ test): `getAlertChannelStatus` is the "is anything configured" gate the tick logs once per run. Unrelated to timing; unchanged.
- `telegram-retry.test.ts`: exercises the real fan-out with fake timers, which is the model my tick test follows. It pins the realistic all-hung total at
  **5 000 + 500 + 5 000 = 10 500 ms** and the ceiling at `TELEGRAM_TOTAL_BUDGET_MS` = 12 000 ms (a 429 asking for the 2 000 ms cap, then a hang). So section 2's 12 000 ms is
  the ceiling; the realistic all-hung case is 10 500 ms. It also pins that email and Discord are sent before the retry pause ends (parallel, not summed), which section 2 relies on.
  My tick test fakes the three channel modules (it models their timeouts directly); the real Telegram channel is covered by this file, not duplicated.
- `telegram.test.ts`: keyboard builder only; no timing. Unchanged.
- `tick/route.test.ts`: auth (401/503), 200 with a mocked `runMonitoringTick`, no `GET` export. It still passes unchanged; my new `route.alerts.test.ts` sits beside it.
- `source-state-machine.rate-limit.test.ts`, `.recovery.test.ts`: both mock `./alert-wrapper` and assert the exact sequence of `emitTransitionAlert` calls (for example
  `active->degraded, degraded->disabled, disabled->degraded, degraded->active`, and exactly one `probe-infra-failure` per streak, quiet 429 degrades with no alert). They pass
  unchanged, which is the evidence that which alerts fire, and when, did not change. In them `after()` throws (no request scope) on every alert and `trackAlert` swallows it.
