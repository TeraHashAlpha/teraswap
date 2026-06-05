# ADR-005 — Source state persistence via Vercel KV with per-tick cache

**Status:** Accepted
**Date:** 2026-04-15
**Authors:** TeraHash (founder/architect)
**Supersedes:** Implicit in-memory `Map` design from Prompt 26
**Related:** ADR-001 (monitoring architecture), ADR-004 (Upstash backend choice), Incident 2026-04-15-002 (C-01)

---

## Context

Prompt 26 (commit `eb2621c`) introduced a source state machine in `src/lib/source-state-machine.ts` to track per-source health. The original design held state in a module-level `Map`:

```ts
const store = new Map<string, SourceStatus>();
```

Auditor review flagged this as **C-01 (Critical):** module state on Vercel lambdas does not survive cold starts and is not shared across concurrent invocations. The state machine could never accumulate the consecutive-failure counts required for transitions. Detail: incident `2026-04-15-002`.

We needed a persistence model that:
- Survives cold starts and is shared across all lambda instances.
- Doesn't add significant latency to per-tick budget (60s tick; H1 + H2 already use ~30s).
- Doesn't multiply KV calls across the per-tick fan-out (~10 sources × 3 read sites per source = 30 reads/tick if naively implemented).
- Maintains the same API surface so callers (`monitoring-loop.ts`, `route.ts`, future split-router consumers) need minimal changes.

## Decision

Two-layer persistence:

### Layer 1 — Vercel KV (Upstash REST) as durable store

Key scheme:

| Key | Type | Value | TTL |
|---|---|---|---|
| `teraswap:source-state:{sourceId}` | string | JSON-serialised `SourceStatus` | none (state is monotonic until next transition) |
| `teraswap:source-state:index` | set | all known source IDs | none |
| `teraswap:monitor:lastTick` | string | ISO timestamp of last successful tick | none |
| `teraswap:monitor:tickCount` | string (numeric) | monotonic counter | none |

All operations through `@vercel/kv`:
- `kv.get(key)` / `kv.set(key, value)` for `SourceStatus`
- `kv.sadd(indexKey, sourceId)` / `kv.smembers(indexKey)` for the index
- `kv.incr(tickCountKey)` for the counter
- `kv.set(lastTickKey, isoTimestamp)` for the heartbeat

### Layer 2 — Per-tick in-memory cache (request-scoped)

Exported helper: `beginTick(): void` clears a module-level cache `Map`. Pattern:

```ts
export async function beginTick(): Promise<void> {
  perTickCache.clear();
}

async function readSourceStatus(sourceId: string): Promise<SourceStatus | null> {
  if (perTickCache.has(sourceId)) return perTickCache.get(sourceId)!;
  const fromKv = await kv.get<SourceStatus>(`teraswap:source-state:${sourceId}`);
  if (fromKv) perTickCache.set(sourceId, fromKv);
  return fromKv;
}
```

Caller contract: `monitoring-loop.ts` calls `beginTick()` exactly once per scheduled tick before fanning out to per-source work. The cache is "good enough" — within a single tick, reading the same `SourceStatus` twice should not produce different results, and any writes within the tick re-populate the cache.

The `@internal` JSDoc warns future contributors that bypassing `beginTick()` (e.g., calling `getStatus()` from outside a tick context) is allowed but accepts a fresh KV read every time.

## Rationale

1. **Correctness over cleverness.** Vercel KV is the simplest design that survives cold starts. No locking, no leader election, no eventual-consistency surprises.
2. **Per-tick cache is the right granularity.** Per-request would be too narrow (multiple internal callers per tick); cross-tick would risk staleness if the state machine transitions mid-tick.
3. **Naming and prefix discipline.** `teraswap:source-state:{...}` namespaces away from rate-limiter (`teraswap:ratelimit:{...}`), monitoring telemetry (`teraswap:monitor:{...}`), and any future workload. No accidental collisions.
4. **No TTL on `SourceStatus`.** The state is the truth; expiring it would mean a state-less window after every TTL boundary.
5. **`@vercel/kv` is the wrapper; `Upstash` is the backend.** Already justified in ADR-004.

## Consequences

### Positive

- C-01 closed. State persists. Empirically validated (incident `2026-04-15-002` § "Empirical validation").
- Latency budget respected. Per-tick fan-out: ~10 sources × ~30ms KV RTT = ~300ms total KV time. H1 + H2 dominate. No regression observed.
- Clean migration path. Only `source-state-machine.ts` changed; callers unchanged.

### Negative

- **KV downtime breaks the state machine.** If Upstash is unreachable, the loop fails fast (no fallback to in-memory). Acceptable: the loop logs and exits the tick, scheduler retries in 60s. No silent fail-open.
- **One more failure mode to monitor.** Add KV health to the monitoring stack itself (Prompt 27.6 alert wrapper).
- **`beginTick()` is implicit.** If a contributor adds a new caller path that doesn't go through `monitoring-loop.ts`, they won't get a fresh tick context. Mitigation: JSDoc `@internal`; future test coverage.

### Neutral

- Cost: ~3 KV calls per source per tick × 10 sources × 1440 ticks/day ≈ 43k req/day if worst-case (no cache hits). With cache, closer to 14k/day. Within Upstash free tier.

## Implementation

| Artifact | Change | Commit |
|---|---|---|
| `src/lib/source-state-machine.ts` | `Map` → KV-backed; `beginTick()` exported; `@internal` JSDoc | `50cdc27` |
| `src/lib/monitoring-loop.ts` | calls `beginTick()` once per tick before fan-out | `50cdc27` |
| Env: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, etc. | populated via Vercel/Upstash integration | infra |

## Validation

Empirical (2026-04-15 00:15 UTC) — see incident `2026-04-15-002` § "Empirical validation":
- 13 ticks counted (`teraswap:monitor:tickCount` = 13).
- 10 sources indexed.
- One sample `SourceStatus` (`balancer`) shows `successCount: 13`, `latencyHistory: [10 entries]`, transitions tracked.

## Reconsideration triggers

- KV req/day budget exceeded → tighten cache (cross-tick read-only mirror with explicit invalidation), or shard by region.
- Multi-region monitoring required → consider Vercel Edge Config for read-heavy fanout, KV remains the writer.
- Stronger consistency required (e.g., distributed locking for state transitions) → introduce a transaction layer or move to a different backend.

## Related

- ADR-001 — monitoring architecture (the loop this state powers)
- ADR-004 — backend choice (Upstash via Vercel)
- Incident 2026-04-15-002 — the bug this ADR closes
- Runbook `docs/Runbooks/KV-troubleshooting.md`
