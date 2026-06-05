# Incident 2026-04-15-002 — C-01: monitoring state lost between lambda invocations

**Severity:** S2 (monitoring stack non-functional from auditor perspective; would have masked real source failures)
**Detected:** 2026-04-14 (auditor review of Prompt 26)
**Root cause introduced:** 2026-04-14 (commit `eb2621c`, Prompt 26)
**Duration of silent failure:** ~36h before fix landed; never reached production due to incident `2026-04-15-001` (cron tier rejection)
**Status:** Resolved 2026-04-15 00:15 UTC (commit `50cdc27`, Prompt 27.5) — empirically validated via 4-curl smoke test

---

## Summary

The monitoring loop in `src/lib/source-state-machine.ts` stored source health state in a module-level JavaScript `Map`:

```ts
const store = new Map<string, SourceStatus>(); // line ~59, pre-fix
```

On Vercel's serverless runtime, every cold lambda invocation produces a **fresh module instance**. The `Map` is therefore wiped on every cold start, and even on warm starts is not shared across regions or concurrent invocations. The state machine could never accumulate the 3 consecutive failures required to transition `active → degraded`, nor the 5 required to disable a source — every tick effectively saw a clean slate.

Net effect: the monitoring system would report all sources as healthy regardless of actual upstream behaviour. A genuine outage of (e.g.) 1inch would not have triggered the state machine, would not have alerted via Telegram, and would not have removed the source from the routing pool.

## Impact

- **Monitoring stack non-functional from a correctness standpoint.** The whole reason for the state machine (resilient detection of intermittent failures) was nullified.
- **No production exposure.** Coincidentally, incident `2026-04-15-001` (Vercel cron tier rejection) prevented the broken code from running in production cron — the lambda would have run on every HTTP hit instead, but no scheduled ticks happened.
- **Auditor caught the bug before any user impact.** This is the system working as intended at the audit layer.

## Detection

Auditor review of Prompt 26 flagged three items, with C-01 as the critical:

> **C-01 (Critical):** `const store = new Map<...>()` at module scope. Vercel lambdas do not share module state across invocations. State lost on cold start. Recommend: persist via Vercel KV; add per-tick cache to avoid redundant reads.

User confirmed ("sim") and Prompt 27.5 was authored.

## Timeline

| Time (UTC) | Event |
|---|---|
| 2026-04-14 ~14:00 | Commit `eb2621c` (Prompt 26) merged with in-memory `Map` state |
| 2026-04-14 ~17:00 | Auditor review surfaces C-01, S-01 (no observability of state file persistence semantics), and 4 lower-severity items |
| 2026-04-14 ~20:00 | Prompt 27.5 authored: switch to Vercel KV with per-tick cache pattern (`beginTick()`) |
| 2026-04-14 ~22:00 | Commit `50cdc27` merged |
| 2026-04-14 → 2026-04-15 | Code blocked from production by incident `2026-04-15-001` (cron tier rejection) |
| 2026-04-15 00:00 | Cron incident resolved (Worker + KV env vars) |
| 2026-04-15 00:15 | 4-curl empirical validation passes — C-01 closed |

## Root cause

1. **Misuse of module-level mutable state in a serverless context.** The original Prompt 26 implementation treated the lambda as if it were a long-running Node process. It is not. Module state lifetime is bounded by the lambda instance lifetime, which is opaque and short-lived.
2. **Auditor framework not run before merge.** The auditor caught this immediately — had the auditor pass been mandatory pre-merge, the bug would never have entered `main`.

## The fix (Prompt 27.5)

Replace `Map` with **two-layer persistence**:

1. **Layer 1 — Vercel KV (Upstash REST):**
   - `teraswap:source-state:{sourceId}` → JSON `SourceStatus`, no TTL (state is monotonic between transitions)
   - `teraswap:source-state:index` → Redis SET of all known source IDs
   - All reads/writes via `@vercel/kv` (HTTP REST, not native Redis)

2. **Layer 2 — Per-tick in-memory cache:**
   - `beginTick()` exported helper clears a request-scoped `Map`
   - First read of a source within a tick hits KV; subsequent reads in the same tick hit cache
   - Avoids N redundant KV calls per source per tick (read for `recordHealthCheck`, read for state machine, read for `getStatus`, etc.)

Other artifacts:
- `@internal` JSDoc block warns future contributors not to bypass `beginTick()` semantics
- `monitoring-loop.ts` calls `beginTick()` once per scheduled invocation

## Empirical validation (smoke test, 2026-04-15 00:15 UTC)

Four curls against the live Upstash KV REST API:

| Key | Result | Validates |
|---|---|---|
| `teraswap:monitor:lastTick` | `2026-04-15T00:16:40.795Z` | Heartbeat is fresh; `set` operation persists |
| `teraswap:monitor:tickCount` | `13` | `incr` operation persists; counter survives cold starts |
| `teraswap:source-state:index` | `[kyberswap, openocean, teraswap-self, odos, paraswap, sushiswap, 0x, 1inch, balancer, cowswap]` | 10-source `sadd` index intact |
| `teraswap:source-state:balancer` | `{state: active, successCount: 13, failureCount: 0, latencyHistory: [10 entries], lastTransitionAt: ...}` | Full `SourceStatus` JSON serialised correctly; latency rotation works |

All four pass. State persists. C-01 empirically closed.

## Remediation (done)

- ✅ Prompt 27.5 implemented (commit `50cdc27`)
- ✅ Vercel KV provisioned via Upstash (`teraswap-kv`) and connected to project
- ✅ Cloudflare Worker scheduler in place (Prompt 27.7) so per-minute ticks actually run
- ✅ Empirical validation via 4-curl smoke test

## Remediation (pending)

- ⏳ Add unit test: `tests/unit/source-state-machine.test.ts` — assert KV calls happen, assert per-tick cache hits, assert state survives a simulated cold start (re-import module)
- ⏳ Add integration test: `tests/integration/monitoring-loop.test.ts` — boot loop, force a failure, assert state transitions
- ⏳ Establish auditor-pass-before-merge as policy for `src/lib/monitoring/**`

## Lessons learned

1. **Serverless ≠ stateful Node.** Anything that needs to outlive a request must persist externally. Period.
2. **Auditor catches matter — they should be blocking.** Three issues caught here would have shipped silently otherwise. Make auditor-pass mandatory for monitoring/security-critical code.
3. **Empirical validation closes the loop.** "Implemented" is not the same as "verified working in production". The 4-curl smoke test is the proof.
4. **Per-tick cache pattern (`beginTick()`) is cheap and high-value.** Trades a little ceremony for N× fewer KV hits per tick. Document this as a pattern for future loops.

## Related

- See also: `Audits/Incidents/2026-04-15-001-vercel-cron-hobby-rejected.md` (masked this fix from production)
- See also: `Audits/Incidents/2026-04-14-002-ratelimit-misconfigured.md` (same KV migration unblocked both)
- ADR: `docs/ADR/ADR-005-state-persistence-vercel-kv.md`
- Runbook: `docs/Runbooks/KV-troubleshooting.md`

## Owner

TeraHash (founder/architect). Sprint 5A.
