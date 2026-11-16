# Feedback — fix/alerts-not-dropped-on-freeze

Base origin/main b47ca15e (PR #687 `chore/tooling-leftovers-2026-11` is on main: the Telegram retry is in `telegram.ts`). No PR (owner opens it).
This file is edited as the work goes; the last edit is the final evidence.

## Checklist
- [x] Gate: retry on main (PR #687, `d18b4118 fix(alerts): one bounded retry for Telegram delivery` is an ancestor of origin/main)
- [x] Premise check + request paths (evidence 1, below)
- [ ] Commit 1: no alert left in flight when the response is sent
- [ ] Commit 2: tests
- [ ] Verify (`scripts/agent-verify.sh --codeql`, `node scripts/gen-claude-state.mjs --check`)
- [ ] Push `fix/alerts-not-dropped-on-freeze`, compare link

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
(`maxDuration = 15`), and nothing else.

**`/api/quote`, `/api/swap`, `/api/v1/quote`, `/api/v1/swap` cannot reach any of the three sites.** They import only `isSystemHalted` from
`circuit-breaker.ts` (a KV read) and the adapters' circuit breaker reads `getAllStatuses`. The goal's "for example /api/quote" is a
conditional ("if it can cause a transition"); it cannot, so no quote path is changed (rate limits, quote results and timing untouched).

Framework hook: Next 16.4.5 exports `after` from `next/server` (`node_modules/next/server.d.ts:21`); stable, no flag in `next.config.js`,
no new dependency. `after()` throws outside a request scope (tests, scripts), which the helper catches.
