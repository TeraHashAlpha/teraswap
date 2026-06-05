# Sprint 5A — Monitoring & Incident Response (consolidated prompt packet)

**Sprint window:** 2026-04-13 → 2026-04-15 (COMPLETE)
**Sprint goal:** ship the four-component monitoring stack from ADR-001 (H1 health checks, H2 TLS/DNS watcher, H5 quorum, H6 alerts) with state persistence, scheduler, and kill-switch.
**Owner:** TeraHash (founder/architect) + code agent
**Status as of 2026-04-15:** 9/9 prompts shipped. Sprint COMPLETE. All auditor findings resolved. 0 critical, 0 high open.

This document consolidates Sprint 5A prompts (25 → 29). Each prompt is reproduced in full prompt-packet format for the code agent and paired with its commit hash, auditor verdict, and follow-up.

---

## Sprint status table

| # | Prompt | Commit | Auditor verdict | Follow-up |
|---|---|---|---|---|
| 25 | Endpoint baseline capture | `4129147` | OK | — |
| 26 | State machine + H1 (health check) | `eb2621c` | **C-01** + S-01 + 4 lower | Prompt 27.5 |
| 27 | H2 (TLS/DNS fingerprint validator) | `0997c4f` | OK + refinement #2 | Prompt 27.5 absorbed it |
| 27.5 | KV persistence + per-tick cache | `50cdc27` | Empirically validated | — |
| 27.7 | Cloudflare Worker scheduler | `a20a9c1` + `08ce21b` | Operational (13 ticks) | Prompt 27.8 |
| 27.6 | Alert wrapper + `MONITOR_GRACE_UNTIL` + auditor fixes (27.6.1) | `0ca6f0b` | **2H + 3M + 3L + 2I** → all fixed (32/32 tests) | — |
| 27.8 | Move Worker to `teraswap.app` route | `9ff6fe5` | Operational (ticks confirmed via route) | — |
| 28 + 28.1 | Contention (weighted thresholds) + watchdog + auditor fixes | `d37446e` | **1C + 1H + 3M + 3L + 2I** → all fixed (47/47 tests) | — |
| 29 | Kill-switch global admin route | `777fa0b` | **0C, 0H, 1M, 3L, 3I** → accepted (79/79 tests) | — |

---

## Prompt 25 — Baseline capture

**Status:** Shipped (`4129147`)

**Context:** before introducing monitoring, capture a TLS + DNS baseline for every endpoint we will watch. This baseline becomes the "known good" reference that H2 compares against.

**Objective:** create a script that probes each endpoint, records issuer/SAN/SHA256 fingerprint of the TLS cert, and A/AAAA/NS records. Output to `data/endpoint-baseline.json`. Re-runnable with `--force` to refresh after legitimate infra changes.

**Files affected:**
- `scripts/baseline-capture.ts` (new)
- `data/endpoint-baseline.json` (new, committed)
- `data/endpoint-baseline-overrides.json` (new, gitignored)

**Quality criteria:** runs idempotently; structured output; supports `--force` flag; documented in script header.

---

## Prompt 26 — Source state machine + H1 health check

**Status:** Shipped (`eb2621c`); auditor flagged C-01; superseded by Prompt 27.5 for state persistence.

**Context:** Build the state machine that each source flows through (`active → degraded → disabled`) and the H1 health-check probe that drives transitions.

**Objective:** implement `src/lib/source-state-machine.ts` exporting `recordHealthCheck()`, `getStatus()`, `getStatusForAllStatuses()`, `forceDisable()`, `forceActivate()`. Implement `src/lib/health-check.ts` with per-aggregator probe URLs, 8s timeout via `AbortController`, latency measurement. Implement `src/lib/monitoring-loop.ts` running every 30s (TLS-only) / 60s (full quote) using `Promise.allSettled`. Add Next.js route `src/app/api/monitor/tick/route.ts` to be triggered by cron.

**State transition rules:**
- `active → degraded`: 3 consecutive failures **OR** p95 latency > 5000ms in last 10 checks
- `degraded → disabled`: 2 additional consecutive failures after degraded (5 total) **OR** `forceDisable()` called
- `disabled → active`: ONLY via `forceActivate()` (manual) **OR** auto after 10 min if `disabledReason` is non-critical (not P0). P0 reasons block auto-recovery: `tls-fingerprint-change`, `dns-record-change`, `kill-switch-triggered`.

**Persistence:** in-memory acceptable for MVP — *(superseded by Prompt 27.5: KV-backed)*

**Alert format:** ⚠️ Source disabled: {id} | Reason: {reason} | Last check: {time} | Dashboard: {link}

**Do NOT:** introduce a real database (in-memory is MVP); change the public interface of split-router; remove or rewrite source-monitor.ts (extend it).

**Quality criteria:** all state transitions unit-tested; loop tested with mock source that fails then recovers; alert fires exactly once per state transition (not on every tick); npm run build passes.

**Auditor verdict (post-merge):**
- 🔴 **C-01:** in-memory `Map` lost on cold start → Prompt 27.5
- 🟡 **S-01:** persistence semantics not documented → addressed via `@internal` JSDoc in 27.5
- 🟡 4 lower-severity items absorbed into Prompt 27.5 and 27.6

---

## Prompt 27 — H2 TLS/DNS fingerprint validator

**Status:** Shipped (`0997c4f`)

**Context:** complement H1 with a tamper-detection probe. H2 reads the TLS cert metadata on the same TCP connection (no extra TLS handshake) and compares against the baseline from Prompt 25. Detects supply-chain attacks, DNS hijacks, and BGP-level interceptions that H1 alone would miss.

**Objective:** implement `src/lib/fingerprint-validator.ts` with `validateTLS()` and `validateDNS()`.

**Validation rules:**
- `validateTLS`: three rules — (1) same issuer + SAN intersection → OK (absorbs Let's Encrypt renewals); (2) exact SHA256 fingerprint match → OK; (3) else fail with reason `tls-fingerprint-change`.
- `validateDNS`: A/AAAA non-empty intersection required; NS exact match; else fail with reason `dns-record-change`.

**Override support:** legitimate infra changes can be allow-listed in `data/endpoint-baseline-overrides.json` (gitignored, manual edit only).

**Co-location with H1:** for aggregator endpoints, send a minimal swap request (e.g., USDC→USDT, 1 unit) using the existing aggregator adapter. Reuse adapter code — do NOT reimplement HTTP. For teraswap-self: HEAD to `https://teraswap.app/` with 5s timeout. Capture TLS cert metadata on the same connection (H2 co-localisation — auditor refinement #2). If the underlying fetch lib exposes the TLSSocket, read `socket.getPeerCertificate(true)` and return in result. If not exposed (likely with `fetch()`), fall back to a separate lightweight `tls.connect()` ONLY when the baseline comparison is needed, not every tick.

**Latency:** request start to response end in ms.

**Files affected:** `src/lib/fingerprint-validator.ts` (new), `data/endpoint-baseline-overrides.json` (new).

**Do NOT:** trigger state transitions from H2 directly — emit signal to state machine which decides.

**Auditor verdict:** OK; refinement #2 (co-location) absorbed before merge.

---

## Prompt 27.5 — KV persistence + per-tick cache (C-01 fix)

**Status:** Shipped (`50cdc27`); empirically validated 2026-04-15 00:15 UTC.

**Context:** auditor flagged C-01 — module-level `Map` does not survive Vercel lambda cold starts. The state machine could never accumulate consecutive-failure counts.

**Objective:** replace `Map` with Vercel KV (Upstash REST), preserving the public API of `source-state-machine.ts`. Add per-tick cache to avoid N redundant KV reads per tick.

**Key scheme:**
```
teraswap:source-state:{sourceId}  → JSON SourceStatus, no TTL
teraswap:source-state:index       → SET of source IDs, no TTL
teraswap:monitor:lastTick         → ISO timestamp, no TTL
teraswap:monitor:tickCount        → integer counter, no TTL
```

**API additions:**
- Export `beginTick(): Promise<void>` — clears per-tick cache. Caller contract: `monitoring-loop.ts` calls this once per scheduled invocation before fan-out.

**Files affected:** `src/lib/source-state-machine.ts` (refactor), `src/lib/monitoring-loop.ts` (call `beginTick()`), JSDoc updates.

**Quality criteria:**
- All existing tests still pass.
- New tests: KV mock; verify state survives a simulated cold start (re-import module).
- `@internal` JSDoc warns against bypassing `beginTick()`.

**Empirical validation (post-Worker deploy):** 4-curl smoke test passes — see incident `2026-04-15-002` § "Empirical validation".

**Detail:** ADR-005.

---

## Prompt 27.7 — Cloudflare Worker scheduler

**Status:** Shipped (`a20a9c1` removed Vercel cron; `08ce21b` added Worker).

**Context:** Vercel Hobby tier silently rejects per-minute cron (`* * * * *`). Three deploys with `crons` block in `vercel.json` failed to deploy without surfacing an error. Detail: incident `2026-04-15-001`.

**Objective:** create a Cloudflare Worker that runs `* * * * *` and POSTs to `https://teraswap.app/api/monitor/tick` with bearer authentication. Move scheduling responsibility off Vercel.

**Files affected:**
- `vercel.json` — remove `crons` block
- `.env.example` — rename `CRON_SECRET` → `MONITOR_CRON_SECRET`
- `workers/monitor-tick-cron/src/index.ts` (new) — `scheduled()` + `fetch()` handlers
- `workers/monitor-tick-cron/wrangler.toml` (new)

**Worker contract:**
- `scheduled()` → POST `${TICK_URL}` with `Authorization: Bearer ${MONITOR_CRON_SECRET}`, log status
- `fetch()` with `/trigger` route → same logic, gated by bearer, for manual smoke testing
- Bindings: `TICK_URL = "https://teraswap.app/api/monitor/tick"`; `MONITOR_CRON_SECRET` (secret)

**Do NOT:** put `MONITOR_CRON_SECRET` in `wrangler.toml`. Use `wrangler secret put MONITOR_CRON_SECRET`.

**Quality criteria:** `wrangler tail` shows `[tick] ok status=200` every minute; KV `tickCount` increments; no auth bypass possible on `/trigger`.

**Detail:** ADR-003.

**Empirical validation:** 13 consecutive ticks observed; `tickCount = 13`.

---

## Prompt 27.6 — Alert wrapper + `MONITOR_GRACE_UNTIL` (drafted, not yet sent)

**Status:** Drafted; pending send.

**Context:** the state machine emits a `recordHealthCheck()` signal when transitions happen, but nothing routes those to humans yet. We need an alert wrapper that fans out to Telegram (primary), Email (secondary), Discord (tertiary), with idempotency keyed on `{sourceId, transition}` so re-firing within a window doesn't spam. We also need a global `MONITOR_GRACE_UNTIL` env var that suppresses alerts during planned maintenance windows.

**Objective:** implement `src/lib/alert-wrapper.ts` + `src/lib/alert-channels/{telegram,email,discord}.ts`. Wire from state-machine transition events. Honour `MONITOR_GRACE_UNTIL` (ISO timestamp) — if set and in the future, route alerts to a logging-only channel.

**Files affected:** `src/lib/alert-wrapper.ts` (new), `src/lib/alert-channels/*.ts` (new), `src/lib/source-state-machine.ts` (emit hook), `.env.example` (add `MONITOR_GRACE_UNTIL`).

**Do NOT:** hardcode chat IDs / webhook URLs (use env). Do NOT block the state-machine tick on alert send latency (fire-and-log).

**Quality criteria:** unit tests for idempotency window (default: 1h); integration test stubs each channel; loop continues even if all channels error.

---

## Prompt 27.8 — Move Worker to `teraswap.app` route (post Cloudflare Registrar)

**Status:** Drafted; blocked on ADR-002 migration completing.

**Context:** Worker is currently exposed at `https://monitor-tick-cron.<account>.workers.dev/` because Cloudflare requires either a `workers.dev` subdomain or a route on a Cloudflare-managed zone. Post-ADR-002 (Cloudflare Registrar migration), `teraswap.app` will be on Cloudflare DNS and we can use a route.

**Objective:** move the Worker to a Cloudflare route on the `teraswap.app` zone (e.g., `cron.teraswap.app/*` or path-based on `teraswap.app/_worker/cron/*`). Disable the `workers.dev` subdomain. Validate `wrangler tail` still works.

**Files affected:** `workers/monitor-tick-cron/wrangler.toml` (replace `workers_dev = true` with `routes = [...]`).

**Do NOT:** expose `/trigger` publicly without bearer (already protected).

**Quality criteria:** `workers.dev` subdomain returns 1101/inactive after change; route fires every minute; bearer still required on `/trigger`.

---

## Prompt 28 + 28.1 — Contention + watchdog + auditor fixes

**Status:** Shipped (`d37446e`); auditor flagged 1C + 1H + 3M + 3L + 2I → all fixed in Prompt 28.1 (47/47 tests).

**Context:** as the source pool grows and aggregator behaviour diverges, a single threshold (3 failures = degraded) becomes too coarse. We want weighted thresholds per source (e.g., teraswap-self has stricter SLO than third-party). We also need an external watchdog: a GitHub Actions cron that hits `/api/monitor/heartbeat` and pages if `lastTick` is older than 5 min — guards against the Worker dying silently.

**Objective:** introduce per-source threshold config in `data/source-thresholds.json`; consume in state-machine transitions. Implement `/api/monitor/heartbeat` returning `{lastTick, tickCount, age}`. Add `.github/workflows/monitoring-watchdog.yml` running `*/5 * * * *` that hits heartbeat and PagerDutys on `age > 5min`.

**Files affected:** `data/source-thresholds.json` (new); `src/lib/source-state-machine.ts` (read thresholds); `src/app/api/monitor/heartbeat/route.ts` (new); `.github/workflows/monitoring-watchdog.yml` (new).

**Quality criteria:** thresholds default to current values if config missing (back-compat); heartbeat is unauthenticated read-only; watchdog doesn't page during `MONITOR_GRACE_UNTIL` window.

---

## Prompt 29 — Kill-switch global admin route

**Status:** Shipped (`777fa0b`); auditor verdict: APPROVED (0C, 0H, 1M, 3L, 3I — accepted as-is, none blocking). 79/79 tests. "Sprint 5A pode fechar."

**Context:** in a security incident (e.g., a confirmed exploit on an aggregator we route through), we need a single command that disables all routes through the affected source AND triggers the alerting cascade. `forceDisable()` exists per-source but there's no admin-grade entry point with auth.

**Objective:** add `/api/admin/kill-switch` (POST) protected by hardware-bound bearer (YubiKey-attested token in `KILL_SWITCH_SECRET`). Body: `{ sourceId, reason }`. Calls `forceDisable(sourceId, reason)` with reason `kill-switch-triggered` (P0). Emits high-priority alert to all channels regardless of `MONITOR_GRACE_UNTIL`.

**Files affected:** `src/app/api/admin/kill-switch/route.ts` (new); `src/lib/source-state-machine.ts` (whitelist `kill-switch-triggered` as P0); `.env.example`.

**Do NOT:** allow re-activation via the same route (re-activation requires manual `forceActivate()` after investigation).

**Quality criteria:** auth failure returns 401 with no information leak; success logged to immutable audit trail (Supabase append-only RLS table); idempotent if called twice with same `{sourceId, reason}`.

---

## Conventions used in this packet

- **Languages:** PT-PT for architect-facing summaries; EN for prompts (consumed by code agent).
- **Prompt structure:** Context / Objective / Requirements / Files affected / Do NOT / Expected output / Quality criteria.
- **Severity:** S0 (incident) / S1 (critical) / S2 (high) / S3 (medium) for incidents; C/H/M/L for auditor findings.
- **Tracking:** every prompt has a commit hash once shipped; every shipped prompt links to its incident or follow-up.

---

## See also

- ADR-001 (monitoring architecture — the why behind H1+H2+H5+H6+kill-switch)
- ADR-003 (Cloudflare Worker scheduler — the why behind Prompt 27.7)
- ADR-005 (state persistence — the why behind Prompt 27.5)
- Audits/Incidents/2026-04-15-001 — Vercel Hobby cron
- Audits/Incidents/2026-04-15-002 — C-01
- Audits/Incidents/2026-04-14-002 — rate-limiter (concurrent infra unblock)
- Runbooks: `docs/Runbooks/{KV-troubleshooting,worker-deployment,rate-limiter-verification}.md`
