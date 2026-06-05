# ADR-003 — Cloudflare Worker as monitoring scheduler

**Status:** Accepted
**Date:** 2026-04-15
**Authors:** TeraHash (founder/architect)
**Supersedes:** N/A
**Related:** ADR-001 (monitoring architecture), Incident 2026-04-15-001 (Vercel cron Hobby rejection)

---

## Context

Sprint 5A introduces a per-minute monitoring loop that ticks the source state machine, runs H1 (health checks) and H2 (TLS/DNS fingerprint validation), and persists state to Vercel KV. The loop must run **at least every 60 seconds** to satisfy the design SLOs (degraded detection within 3–4 min, disable within 5–6 min).

Three scheduler options were considered:

| Option | Cadence supported | Cost | Trade-off |
|---|---|---|---|
| **A. Vercel Cron (Hobby)** | Daily only | $0 | Free but rejects sub-daily schedules silently. Hard blocker for our SLO. |
| **B. Vercel Cron (Pro)** | Per-minute | $20/mo | Co-located with the lambda; one tier. Cost adds up across infra (already ~$100/mo non-Vercel). |
| **C. Cloudflare Worker** | Per-minute (and finer) | $0 (free tier: 100k req/day) | Adds a second platform; per-minute supported on free tier; calls back to Vercel via HTTPS POST. |

We chose **Option C** (Cloudflare Worker scheduler).

## Decision

A small Cloudflare Worker (`workers/monitor-tick-cron/`) runs `* * * * *` (every minute) and POSTs to `https://teraswap.app/api/monitor/tick` with bearer authentication. The Vercel app is the workhorse; the Worker is purely a clock.

```
[Cloudflare Worker, * * * * *]
        │ HTTPS POST + Bearer MONITOR_CRON_SECRET
        ▼
[Vercel /api/monitor/tick]
        │ beginTick() → H1 + H2 in parallel → state machine → KV write
        ▼
[Vercel KV (Upstash REST)]
```

Worker code surface:
- `scheduled()` handler — fires on cron, calls `fetch(TICK_URL, { method: 'POST', headers: { Authorization: 'Bearer ${MONITOR_CRON_SECRET}' } })`, logs status
- `fetch()` handler with `/trigger` route — same logic, gated by bearer, for manual smoke testing

Bindings:
- `TICK_URL = "https://teraswap.app/api/monitor/tick"`
- `MONITOR_CRON_SECRET` (secret, never logged)

## Rationale

1. **Cost.** Vercel Pro is $20/mo per project. Cloudflare Workers free tier handles 100k req/day; we use ~1.4k/day (one per minute). Free indefinitely at our scale.
2. **Cadence flexibility.** Cloudflare cron triggers support sub-second granularity in some scenarios; certainly per-minute, which Vercel Hobby does not.
3. **Failure isolation.** If the Worker breaks, Vercel still serves quote/swap APIs normally — only monitoring degrades. If Vercel breaks, the Worker just logs failed POSTs. Two single-points-of-failure are independent.
4. **Bring-your-own-clock pattern.** The same Worker pattern can drive future scheduled jobs (cache warming, daily rollups, etc.) without additional infrastructure cost.
5. **Already a Cloudflare zone.** `teraswap.app` will be on Cloudflare DNS post-ADR-002. Adding a Worker is a natural extension; same dashboard, same auth.

## Consequences

### Positive

- $0 incremental cost for scheduling.
- Per-minute monitoring SLO achievable.
- Clean separation: scheduler vs. workload.
- Pattern reusable for other periodic tasks.

### Negative

- **Two-platform deployment.** Worker code lives in `workers/monitor-tick-cron/`; Vercel code in `src/`. Two deploy pipelines. Documented in `docs/Runbooks/worker-deployment.md`.
- **Bearer secret distribution.** `MONITOR_CRON_SECRET` must be set in both Vercel env vars (validation) and Cloudflare Worker secrets (sender). Rotation is two-step.
- **`workers.dev` subdomain temporarily exposed.** The Worker is initially deployed to a `workers.dev` subdomain because Cloudflare requires either a subdomain or a route. Routes require the zone to be on Cloudflare DNS, which happens in ADR-002. Until then, the subdomain is exposed but `/trigger` is bearer-gated. Fix: Prompt 27.8 moves the Worker to a `teraswap.app` route post-ADR-002.

### Neutral

- Worker logs available via `wrangler tail` (good for debugging) but not aggregated into Vercel/Sentry by default.

## Implementation

| Artifact | Location | Commit |
|---|---|---|
| Worker source | `workers/monitor-tick-cron/src/index.ts` | `08ce21b` |
| Worker config | `workers/monitor-tick-cron/wrangler.toml` | `08ce21b` |
| `vercel.json` cleanup | `vercel.json` (crons block removed) | `a20a9c1` |
| Env var rename | `.env.example` (`CRON_SECRET` → `MONITOR_CRON_SECRET`) | `a20a9c1` |

## Validation

Empirical (2026-04-15 00:15 UTC): 13 consecutive ticks observed via `wrangler tail`, KV `tickCount` = 13, all ticks returned HTTP 200.

## Reconsideration triggers

Move back to a single platform (Vercel Pro Cron) if:
- Cloudflare Worker free tier is exhausted (>100k req/day — would require ~70 ticks/min; not happening).
- Operational cost of two-platform deployment exceeds $20/mo of engineering time per month.
- A future requirement makes co-location strictly necessary (e.g., zero-network-hop scheduling — currently no such requirement).

Move to a third option (e.g., GitHub Actions cron, EventBridge) if:
- Cloudflare suffers a multi-day outage that affects Workers but not the rest of our stack.
- We need cron expressions Cloudflare doesn't support.

## Related

- ADR-001 — monitoring architecture (defines the work the scheduler triggers)
- ADR-002 — Cloudflare Registrar (precondition for moving Worker to `teraswap.app` route)
- Incident 2026-04-15-001 — the trigger for this decision
- Runbook `docs/Runbooks/worker-deployment.md`
