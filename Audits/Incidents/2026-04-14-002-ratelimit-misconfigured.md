# Incident 2026-04-14-002 — Rate-limiter silently broken for 13 days

**Severity:** S3 (degraded, no user-facing breach)
**Detected:** 2026-04-14 ~23:00 UTC (accidental discovery during C-01 smoke test)
**Root cause introduced:** 2026-04-02 (rate-limiter refactor to `@vercel/kv`)
**Duration of silent failure:** ~13 days
**Status:** Resolved 2026-04-15 00:15 UTC

---

## Summary

The production rate-limiter (`src/lib/kv-rate-limiter.ts`) has been **non-functional in production since 2026-04-02**. The code imports `@vercel/kv` v3.0.0, which speaks the Upstash HTTP REST protocol and requires env vars `KV_REST_API_URL` + `KV_REST_API_TOKEN`. The deployed Vercel project was instead wired to a **Redis Cloud** database (`teraswap-ratelimit`) which only exposes the native **TCP Redis protocol** (`rediss://...:6379`). The two are wire-incompatible.

Every rate-limit check silently threw, was swallowed by try/catch, and defaulted to "allow". No Sentry alert fired because the failure path was coded as non-blocking (intentional for availability during KV outages).

Secondary factor: the Redis Cloud database entered **Suspended** status at some point before detection due to inactivity on the free tier — meaning even if the client had been compatible, the backend was offline.

## Impact

- **API surface:** `/api/quote`, `/api/approve`, `/api/swap` — no rate-limiting enforced
- **Abuse window:** ~13 days
- **Financial impact:** None detected. Upstream aggregator rate-limits (1inch, 0x, Paraswap, etc.) absorbed the risk implicitly.
- **Data impact:** None. Rate-limiter is stateless from user POV.

## Detection

Discovered accidentally while debugging the monitoring stack. User ran `vercel env pull` and observed that `KV_*` env vars did not exist. Investigation revealed:

1. Vercel project → Storage tab showed `teraswap-ratelimit` as **Suspended**
2. Database type was Redis Cloud, not Upstash
3. Code path: `src/lib/kv-rate-limiter.ts` imports `kv` from `@vercel/kv`
4. Incompatibility identified

## Timeline

| Time (UTC) | Event |
|---|---|
| 2026-04-02 ~14:00 | Rate-limiter refactor to `@vercel/kv` merged |
| 2026-04-02 → 2026-04-14 | 13 days of silent failure |
| 2026-04-14 23:00 | User observed missing `KV_*` env vars in Vercel |
| 2026-04-14 23:20 | Root cause identified: Redis Cloud × `@vercel/kv` incompatibility |
| 2026-04-14 23:45 | New Upstash database `teraswap-kv` created |
| 2026-04-15 00:00 | `teraswap-kv` connected to Vercel project; 5 env vars populated |
| 2026-04-15 00:15 | Empirical validation via 4 curls — rate-limiter unblocked (Tick 13 confirmed state persistence) |

## Root cause

Two-layer failure:

1. **Client/backend protocol mismatch.** `@vercel/kv@3.0.0` is a thin wrapper around the Upstash REST API. Redis Cloud does not speak Upstash REST. This should have been caught by any integration test, but none existed for the rate-limiter.
2. **Silent-swallow error handling.** The rate-limiter was designed to fail-open for availability. This is correct behaviour but must be paired with an alert on sustained error rate — which was not implemented.

## Remediation (done)

- ✅ Created Upstash database `teraswap-kv`
- ✅ Connected to Vercel project — populates `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_REDIS_URL`
- ✅ Redeploy to pick up env vars
- ✅ Empirically validated via monitoring stack (which uses same KV)

## Remediation (pending)

- ⏳ Delete old `teraswap-ratelimit` Redis Cloud database (after 7 days grace)
- ⏳ Add integration test: `tests/integration/rate-limiter.test.ts` — hit real KV, assert counter increments
- ⏳ Add Sentry alert rule: `kv-rate-limiter error rate > 1%` over 5 min
- ⏳ Document in `docs/Runbooks/rate-limiter-verification.md` (how to verify rate-limiter works after infra changes)
- ⏳ Add smoke test to CI: after deploy, hit a rate-limited endpoint N+1 times, assert last one returns 429

## Lessons learned

1. **Protocol compatibility is a first-class concern.** When choosing a KV backend, verify client library matches wire protocol. `@vercel/kv` only speaks REST (Upstash), not native Redis (Redis Cloud, AWS ElastiCache, Redis Labs non-REST tier).
2. **Fail-open must be paired with alarm.** Silent graceful degradation without alerting is equivalent to silent failure.
3. **Storage tab inactivity suspension is a real risk.** Free-tier databases can be suspended without notice. Production infra should be on paid tier or have a keep-alive ping.
4. **Manual env var audit is cheap insurance.** A quarterly `vercel env pull` + grep + compare against a manifest would have caught this on day 1.

## Related

- See also: `docs/audits/Incidents/2026-04-15-001-vercel-cron-hobby-rejected.md` (discovered same session)
- See also: `docs/audits/Incidents/2026-04-15-002-c01-inmemory-state.md` (same sprint, same infra)
- ADR: `docs/ADR/ADR-004-upstash-kv-over-redis-cloud.md`
- Runbook: `docs/Runbooks/rate-limiter-verification.md`

## Owner

TeraHash (founder/architect). Sprint 5A.
