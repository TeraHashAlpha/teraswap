# ADR-004 — Upstash KV (Vercel-managed) over Redis Cloud

**Status:** Accepted
**Date:** 2026-04-15
**Authors:** TeraHash (founder/architect)
**Supersedes:** Implicit prior choice (Redis Cloud `teraswap-ratelimit`, in use since 2026-04-02)
**Related:** Incident 2026-04-14-002 (rate-limiter silent failure), ADR-005 (state persistence)

---

## Context

TeraSwap needs a low-latency key/value store for two workloads:

1. **Rate-limiter** (since 2026-04-02): per-IP / per-API-key request counters, ~1 req/s baseline, bursty.
2. **Monitoring state** (Sprint 5A, 2026-04-14): source state machine, tick counters, heartbeat.

Both workloads were originally targeted at the existing Redis Cloud free-tier database `teraswap-ratelimit` (`rediss://...:6379`). On 2026-04-14 we discovered that this database had been **silently incompatible** with the `@vercel/kv` client library since 2026-04-02 (incident `2026-04-14-002`).

Two backend options for KV-style workloads on Vercel:

| Option | Wire protocol | Vercel client | Free tier | Verdict |
|---|---|---|---|---|
| **A. Redis Cloud (free tier)** | Native Redis (TCP, `rediss://...:6379`) | Requires `ioredis` or `redis@4` | 30MB, 30 conns | Incompatible with `@vercel/kv`. Has a Suspended-on-inactivity policy that bit us. |
| **B. Upstash (via Vercel Marketplace, branded `Vercel KV`)** | HTTP REST + native Redis | `@vercel/kv` natively | 256MB, 10k req/day | Designed for serverless. No connection pooling concerns. |

We chose **Option B** (Upstash).

## Decision

Provision a single Upstash database (`teraswap-kv`) via Vercel's storage marketplace. Both rate-limiter and monitoring state share this database, namespaced by key prefix:

```
teraswap:ratelimit:{ip}                  → rate-limit counters (TTL: rolling window)
teraswap:source-state:{sourceId}         → SourceStatus JSON (no TTL)
teraswap:source-state:index              → SET of source IDs
teraswap:monitor:lastTick                → ISO timestamp (no TTL)
teraswap:monitor:tickCount               → integer counter (no TTL)
```

The connection details (`KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_REDIS_URL`) are auto-injected by Vercel as env vars across all environments (Production, Preview, Development).

## Rationale

1. **Wire protocol matches the client.** `@vercel/kv` is a thin wrapper over Upstash's HTTP REST API. Using Upstash means zero protocol mismatch risk.
2. **Serverless-native.** HTTP REST means no connection pool, no `MaxClientsReached` errors at scale, no idle-connection eviction. Perfect for Vercel's lambda model.
3. **No suspension on inactivity.** Upstash via Vercel Marketplace stays warm; Redis Cloud free tier suspended `teraswap-ratelimit` after a quiet period (root cause of 13-day rate-limiter silent failure).
4. **One database for two workloads.** 256MB free tier is plenty for both rate-limit counters and ~20 monitoring keys. Keeps cost at $0 and avoids dual-store complexity.
5. **First-party Vercel integration.** Env var injection, dashboard-level monitoring, and Vercel support cover both layers.

## Consequences

### Positive

- Rate-limiter unblocked (closes incident `2026-04-14-002`).
- Monitoring state persists across cold starts (closes incident `2026-04-15-002` / C-01).
- Zero monthly cost at current scale.
- Single source of truth for all KV-style state.

### Negative

- **HTTP overhead per call.** Upstash REST has ~10–30ms RTT. Acceptable for our workload (per-tick budget is 60s; rate-limit decision is ~30ms). Documented in monitoring SLOs.
- **Vendor lock-in (mild).** `@vercel/kv` is a thin wrapper; in principle we could swap to direct Upstash SDK or another REST KV. Migration risk is low.
- **Free tier limits.** 10k req/day is the soft cap. We currently project ~3–5k/day (rate-limit + monitoring combined). Monitor usage in `docs/Runbooks/KV-troubleshooting.md` § "usage tracking".

### Neutral

- The old `teraswap-ratelimit` Redis Cloud database stays around for 7 days (post-mortem evidence) then gets deleted. Tracked in incident `2026-04-14-002`.

## Implementation

| Action | Status |
|---|---|
| Provision `teraswap-kv` on Vercel Marketplace | ✅ done 2026-04-15 |
| Connect to `teraswap` Vercel project | ✅ done 2026-04-15 |
| Verify 5 env vars populated (Production/Preview/Development) | ✅ done 2026-04-15 |
| Redeploy Vercel project to pick up env vars | ✅ done 2026-04-15 |
| Empirical validation (4-curl smoke test) | ✅ done 2026-04-15 |
| Delete `teraswap-ratelimit` Redis Cloud | ⏳ pending 2026-04-22 (7-day grace) |

## Validation

See incident `2026-04-15-002` § "Empirical validation" — 4 curls against the new database confirm reads, writes, set membership, and counter increments all behave correctly.

## Reconsideration triggers

Reconsider this choice if:
- Free tier exhausted: >10k req/day sustained → upgrade to paid Upstash (~$10/mo) or shard.
- Latency exceeds budget: p95 KV RTT >100ms sustained → consider Vercel Edge Config for read-heavy paths or a cache layer.
- Vercel deprecates the `@vercel/kv` SDK: migrate to `@upstash/redis` direct (same data, different import).
- A workload requires features Upstash doesn't have (e.g., Streams, Pub/Sub at scale, Lua scripting): split that workload to a dedicated Redis Cloud paid instance.

## Related

- Incident 2026-04-14-002 — root cause that forced this decision
- Incident 2026-04-15-002 — concurrent need for the same backend (monitoring state)
- ADR-005 — applies this choice specifically to monitoring state persistence
- Runbook `docs/Runbooks/KV-troubleshooting.md`
- Runbook `docs/Runbooks/rate-limiter-verification.md`
