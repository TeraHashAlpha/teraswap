# fix/executor-alert-masking-rpc-auth — feedback (INC-2026-10-30-001)

Base origin/main `ebaf0be` (main later moved to `3b8e34c`: dependabot #602/#609, package files only, no overlap).
Auditor-note: keeper + monitor/CI code — owner opens the PR as DRAFT. Compare: `main...fix/executor-alert-masking-rpc-auth`

## Checklist
- [x] C1 `redact.js` (redactUrl/redactError) on every alert + log path; keyed-URL alert test; console guard test
- [x] C2 RPC auth = FATAL-OPS: boot AUTH line + HIGH alert; runtime 3 → one rate-limited alert + `paused: rpc-auth`
- [x] C3 `Audits/Incidents/INC-2026-10-30-001.md` + read-only impact SQL (§6) + runbook § 7 "Changing an RPC key"
- [x] C4 monitor tick + daily report read `keeper_runtime_config.paused` (owner answer 3)
- [x] Keeper + full suite vs origin/main, lint delta 0, tsc clean, pushed, compare link

## Owner answers (in-session, supersede the goal text)
1. Orders schema is not in `supabase/migrations` (ALTERs only) → read `contracts/order-engine/schema.sql` orders block.
2. `paused` placement → grep consumers first: nothing read keeper state; host is SSM-only ⇒ Supabase is the only
   off-host channel ⇒ `paused` on `/health`, `/metrics`, heartbeat, `keeper_runtime_config` (migration).
3. Monitor/daily report must SHOW it (premise false: neither read keeper state) → "wire it now". Extra reads:
   keeper-health-monitor.ts(+test), tick route(+test), /api/health, daily-health-report.yml; grep-only: the
   `/api/monitor/alerts` auth line and alert-wrapper's dedup docblock.

## Evidence
1. `alertOps` body, fixture HttpRequestError (same input, origin/main → branch; Status/Details lines unchanged):
   `URL: https://base-mainnet.g.alchemy.com/v2/TESTKEY` → `URL: https://base-mainnet.g.alchemy.com/REDACTED`
2. Guard (`redact.test.mjs`, `REDACT_GUARD_DIR=<origin/main>`): 20 raw-error sinks — alert 1, env 1, event-watcher 2,
   executor 12, monitor 4 (incl. `executor.js:1147` the leaking alert) → branch 0. redact suite 21/21.
3. `rpc-auth.test.mjs` 36/36 on real viem errors: JSON-403 whitelist → auth (viem DROPS the 403; text carries it),
   401 / HTML-403 / "invalid api key" → auth; 503 / 429 / ECONNREFUSED / revert-text → transient. Runtime: 2 → nothing,
   3 → AUTH line + `paused` + 1 alert; 11 polls in 55 min → 0 alerts, 60 min → 1 reminder "11 suppressed"; watcher 12
   polls → 1 alert, 0 Degraded; success → 1 recovery. Real `executor.js` boot vs 403: exit 1 + exact line + 1 HIGH
   alert + PATCH paused; pm2-style re-boot → 0 alerts. Off-host: tick alerts `keeper-paused-8453` active→disabled
   (deduped 1 h), `/api/monitor/keepers` 401/503/OK/PAUSED/UNKNOWN; report compose run on fixtures: paused →
   🔴 CRITICAL + ❌ row + runbook bullet, OK → ✅, unreadable → 🟡 ⚠️; hostile body sanitized (no newline/pipe).
   Mutations (watcher Degraded, monitor cooldown, boot gate, tick pause alert) each fail their test.
4. `Audits/Incidents/INC-2026-10-30-001.md` §6: one SELECT on `orders`, chain_id 8453, window 2026-10-30 15:00 →
   10-31 11:15 UTC; flags changed / failed / expired_in_window (`to_timestamp(expiry)`) + `dca_run_missed`.
5. Keeper `node --test` 805/805 (base 748) · vitest 396 files/6291 (base 395/6281: +1 file, +10) · lint 93 = base ·
   tsc 0 · `git diff --stat ebaf0be` (excl. this file): 23 files, +2156 −60 — keeper 10 src + 4 tests, web 2 + 2
   tests, CI 1, SQL 2 (migration, schema.sql), docs 2 (incident, runbook).

## Findings
- Concern: an auth outage WITH active orders still burns the retry ladder (8 misses → `failed`,
  `no_route_after_retries`). Untouched (no execution-logic change in scope) — owner decision.
- Security: the key shown in Telegram stays usable — a domain allowlist is an Origin-header check. Rotate it (INC §8).
- Edge: Telegram parse_mode HTML rejects a message whose error Details is an HTML page — that alert was lost; Degraded +
  monitor alerts now `esc()`. Kept: chain-verify's own stricter `redactUrls`. Guard covers executor `*.js` only.
- Owner: apply migration `20261031120000_keeper_runtime_config_paused.sql` — until then the report says UNKNOWN (⚠️).

## Feedback — CI fix: keeper suite "fail 0 / cancelled 6" (PR #636)
- Cause: `rpc-auth.test.mjs` "a hung Supabase…" faked the hung PATCH with a promise that settled only on `abort`.
  It held no handle, and `AbortSignal.timeout()`'s timer is unref'd, so on CI's Node 20.20.2 / 22.23.4 the runner saw
  a drained loop ("Promise resolution is still pending but the event loop has already resolved") and cancelled that
  test plus the 5 after it in the file (metrics, 3 wiring anchors, the real `executor.js` boot). Node 25.6.1 (local)
  does not cancel: evidence 5's "805/805" above was measured on the wrong Node. Runtime unaffected: the keeper's
  `supabaseFetch` is a real `fetch`, whose socket keeps the loop alive until the 5 s abort.
- Fix (test only, no runtime change, no assertion removed): a real local server that accepts the PATCH and never
  answers, reached by an executor-shaped `supabaseFetch`; now also asserts the PATCH arrived and the reason names
  the timeout. Test `timeout: 10_000` + `t.after` teardown: a regression fails in 10 s instead of hanging the job.
- Evidence: before, local Node 20.20.2 = CI (799 pass, 6 cancelled, exit 1). After, keeper `node --test` as CI:
  Node 20.20.2 + `npm ci --ignore-scripts` 5/5 runs 805/805; Node 22.23.4 + `npm ci` 5/5 runs 805/805; 0 cancelled.
  Mutation (drop `AbortSignal.timeout` from `publishPausedState`) → the test fails in 10 s. vitest 396 files/6291 ·
  lint 93 (file is ESLint-ignored) · tsc 0.
- Test gap: run keeper tests on CI's Node (20 and 22), not the host default.

## Feedback — Auditor A71 fixes (0C/0H/2M/6L, all fixed; one droppable commit per id)
| id | commit | change | test (fails on 6d7e64d) |
|---|---|---|---|
| M-1 | bd4634c | auth streak per origin/method; `muted` = auth AND paused gates Degraded / "Ops issue: rpc" / onCycleError; full cycle reports `cycle` success | rpc-auth-partial.test.mjs: 50 alternating → alert + paused (monitor and real watcher); muted only while paused; 8 fail |
| M-2 | 8fb9f2e | route: any active chain unreadable → UNKNOWN; report: ✅ only with no `unreadable` token, tokens mark inactive chains | route.test.ts + `__tests__/daily-health-report-keepers.test.ts` (runs the YAML's own scripts); 4 fail |
| L-1 | 807acf4 | `checkRateLimit("monitor:<ip>", 30, 60s)` before auth → 429 | route.rate-limit.test.ts; 3/3 fail |
| L-2 | 5951b06 | an HTTP status ≠ 401/403 ⇒ transient, body not matched | rpc-auth-status.test.mjs (real viem errors); 4 fail |
| L-3 | 417e2ef | future lastSentAt = never sent; gate file in `~/.teraswap-keeper` (0700/0600), untrusted dir ignored | rpc-auth-boot-gate.test.mjs; 5/5 fail |
| L-4 | 5937d18 | `\+/` → `/` first; scheme not preceded by `[a-z0-9+.-]` | redact-shapes.test.mjs; 9 fail |
| L-5 | 030cfa3 | guard: `console.\w+`, catch-bound names, all alert builders, `{ err }` | new scanner test fails with 6d7e64d's scanner |
| L-6 | ea9d0ee | §7 step 1: `^\s*(export )?VAR\s*=` (POSIX classes) + by-hostname pass | runbook-rpc-inventory.test.mjs runs the runbook block; fails |

- Evidence: each commit reverts cleanly alone on ea9d0ee, and the keeper suite and the keepers vitest tests stay green
  after each revert. Keeper `node --test` 832/832: Node 20.20.2 + `npm ci --ignore-scripts` 5/5, Node 22.23.4 +
  `npm ci` 5/5, 0 cancelled. Stronger guard: branch 0 raw-error sinks; origin/main ebaf0be 20.
- Edge (M-1): recovery waits until every refused origin answers once (after a full outage: the watcher's getLogs
  plus the next full cycle's balance read). The `cycle` success report is reporting only; execution is unchanged.
- Edge (L-2 residual): a JSON-RPC error carries no HTTP status in viem, so "unauthorized" in, e.g., a -32603 body still
  counts as auth. There is no status to decide by.
- Edge (L-3): the first boot after deploy ignores the old /tmp gate file, so at most one extra boot alert.
- Gap (L-6): GNU grep/sed not run locally (none installed, Docker daemon off). The block is POSIX ERE only, and the
  Ubuntu keeper CI jobs run the test.
- Process: PR #636 was not a draft at the start of this session; converted back to draft as instructed.
- Process: the first tsc run failed on two of the new test files (Next's ProcessEnv requires NODE_ENV; a
  header-array type). Both fixes were folded into their own finding commits (M-2, L-1) before the first push.
  The final tree differs from the verified 2d7d484 tree only in those 3 test lines. tsc 0 · lint 93 (= base) ·
  vitest 398 files/6299.
