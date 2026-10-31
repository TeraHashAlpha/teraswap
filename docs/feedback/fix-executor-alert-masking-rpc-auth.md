# fix/executor-alert-masking-rpc-auth — feedback (INC-2026-10-30-001)

Base origin/main `ebaf0be` (main later moved to `3b8e34c`: dependabot #602/#609, package files only, no overlap).
Auditor-note: keeper code — owner opens the PR as DRAFT. Compare: `main...fix/executor-alert-masking-rpc-auth`.

## Checklist
- [x] C1 `redact.js` (redactUrl/redactError) on every alert + log path; keyed-URL alert test; console guard test
- [x] C2 RPC auth = FATAL-OPS: boot AUTH line + HIGH alert; runtime 3 → one rate-limited alert + `paused: rpc-auth`
- [x] C3 `Audits/Incidents/INC-2026-10-30-001.md` + read-only impact SQL (§6) + runbook § 7 "Changing an RPC key"
- [x] Keeper + full suite vs origin/main, lint delta 0, tsc clean, pushed, compare link

## Owner answers (in-session, supersede the goal text)
- Orders schema is not in `supabase/migrations` (ALTERs only) → read `contracts/order-engine/schema.sql` orders block.
- `paused` placement → grep consumers first: nothing reads keeper `/health`; daily report = web `/api/health` +
  on-chain balance; `keeper_runtime_config` read only by `/api/dca-floor-cap`. Host is SSM-only ⇒ Supabase is the
  only off-host channel ⇒ `paused` on `/health`, `/metrics`, heartbeat, `keeper_runtime_config` (migration).

## Evidence
1. `alertOps` body, fixture HttpRequestError (same input, origin/main → branch; Status/Details lines unchanged):
   `URL: https://base-mainnet.g.alchemy.com/v2/TESTKEY` → `URL: https://base-mainnet.g.alchemy.com/REDACTED`
2. Guard (`redact.test.mjs`, `REDACT_GUARD_DIR=<origin/main>`): 20 raw-error sinks — alert 1, env 1, event-watcher 2,
   executor 12, monitor 4 (incl. `executor.js:1147` the leaking alert, `:2429` `console.error("Fatal error:", err)`)
   → branch 0. redact suite 21/21.
3. `rpc-auth.test.mjs` 36/36, real viem errors from a local "provider": JSON-403 whitelist → auth (viem DROPS the 403;
   text carries it), 401/HTML-403/"invalid api key" → auth; 503/429/ECONNREFUSED/revert-text → transient. Runtime:
   2 → nothing, 3 → AUTH line + `paused: rpc-auth` + 1 alert; 11 more polls in 55 min → 0 alerts, 60 min → 1 reminder
   "11 suppressed"; 12 watcher polls → 1 alert, 0 Degraded; success → 1 recovery. Real `executor.js` boot vs 403:
   exit 1 + exact line + 1 HIGH alert + PATCH paused; pm2-style re-boot → 0 alerts. Mutating any of the three guards
   (watcher Degraded, monitor cooldown, boot gate) fails its test.
4. `Audits/Incidents/INC-2026-10-30-001.md` §6: one SELECT on `orders`, chain_id 8453, window 2026-10-30 15:00 →
   10-31 11:15 UTC; flags changed / failed / expired_in_window (`to_timestamp(expiry)`) + `dca_run_missed`
   (`COALESCE(dca_last_exec + dca_interval s, created_at)` < t1 while live).
5. Keeper `node --test` 805/805 (base 748/748) · vitest 395 files/6281 = base · lint 93 warnings = base · tsc 0.
   `git diff --stat ebaf0be` (excl. this file): 18 files, +1809 −55 — 9 keeper sources, 4 tests, migration +
   schema.sql, incident, runbook.

## Findings
- Concern: an auth outage WITH active orders still burns the retry ladder (8 misses → `failed`,
  `no_route_after_retries`). Untouched (no execution-logic change in scope) — owner decision.
- Security: the key shown in Telegram stays usable — a domain allowlist is an Origin-header check. Rotate it (INC §8).
- Edge: Telegram parse_mode HTML rejects a whole message whose error Details is an HTML page (a 403 challenge) — that
  alert was silently lost; Degraded + monitor alerts now `esc()` their error text.
- Kept: `chain-verify.js` own stricter `redactUrls` (whole URL → `<redacted-url>` + hex), pinned by its tests.
- Gap: the guard covers executor `*.js`; operator scripts `backfill-execution.mjs` / `list-missing-fills.mjs` were
  out of read scope. Boot-gate state is a per-chain file in `os.tmpdir()` (cleared on reboot ⇒ re-alert, intended).
- Owner: apply migration `20261031120000_keeper_runtime_config_paused.sql`; wire monitor/daily report to `paused`.
