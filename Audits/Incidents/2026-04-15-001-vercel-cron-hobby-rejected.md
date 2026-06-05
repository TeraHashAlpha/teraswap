# Incident 2026-04-15-001 — Vercel Hobby tier silently rejecting per-minute cron

**Severity:** S2 (production deploys blocked, monitoring stack non-deployable)
**Detected:** 2026-04-14 ~22:30 UTC
**Root cause introduced:** 2026-04-14 (commit `eb2621c`, Prompt 26)
**Duration of silent failure:** ~24h (3 deploys stuck)
**Status:** Resolved 2026-04-15 00:00 UTC (commits `a20a9c1` + `08ce21b`)

---

## Summary

The Vercel **Hobby tier** silently rejects deployments containing a `crons` block in `vercel.json` with sub-daily cadence (`* * * * *` per minute). Three consecutive commits (`eb2621c`, `0997c4f`, `50cdc27`) failed to deploy without producing any visible error in the Vercel dashboard — the deployment simply did not transition out of "Building" or was marked Ready but with stale code.

The Hobby tier officially supports **only daily cron jobs** (one per day per project). Anything more frequent is rejected, but the rejection happens at deployment-validation time without surfacing a clear error to the user. The dashboard shows the deploy as queued/building until eventually marked Ready against the previous successful commit.

## Impact

- **Sprint 5A blocked.** Three commits with new monitoring infrastructure (state machine, H1 health check, H2 TLS/DNS watcher, KV persistence) could not reach production for ~24h.
- **C-01 fix invisible.** The Vercel KV persistence fix (commit `50cdc27`) was not running in production, so the in-memory state bug remained live during the troubleshooting window.
- **No user-facing breach.** Quote/swap APIs unaffected; this only blocked the monitoring deployment.

## Detection

Triggered by user observation that wrangler tail and curls against `https://teraswap.app/api/monitor/tick` returned stale or expected behaviour from old code, despite three pushes to `main`. Investigation:

1. Vercel dashboard → Deployments → all three commits showed as "Ready" but `git log` of running production matched `eb2621c` only on hash, not on behaviour.
2. Inspection of `vercel.json` revealed `crons: [{ path: "/api/monitor/tick", schedule: "* * * * *" }]`.
3. Vercel docs reviewed: Hobby tier limits crons to daily cadence.
4. Hypothesis confirmed: removing the `crons` block unblocks deployment.

## Timeline

| Time (UTC) | Event |
|---|---|
| 2026-04-14 ~14:00 | Commit `eb2621c` (Prompt 26) merged with `* * * * *` cron in `vercel.json` |
| 2026-04-14 ~17:00 | Commit `0997c4f` (Prompt 27) merged — same blockage |
| 2026-04-14 ~22:00 | Commit `50cdc27` (Prompt 27.5, C-01 fix) merged — same blockage |
| 2026-04-14 22:30 | User observes monitoring stack not behaving as expected |
| 2026-04-14 23:00 | Root cause identified — Hobby tier cron limit |
| 2026-04-15 00:00 | Commit `a20a9c1` — `crons` block removed from `vercel.json`; `CRON_SECRET` renamed to `MONITOR_CRON_SECRET` |
| 2026-04-15 00:00 | Commit `08ce21b` — Cloudflare Worker scheduler created (`workers/monitor-tick-cron/`) |
| 2026-04-15 00:10 | Worker deployed via Wrangler with `CLOUDFLARE_API_TOKEN` workaround |
| 2026-04-15 00:15 | First successful tick observed via `wrangler tail` |

## Root cause

1. **Tier mismatch undocumented in code.** `vercel.json` does not constrain itself to Hobby tier capabilities. Anyone could (and did) write a config that the chosen plan cannot serve.
2. **Silent failure mode.** Vercel's Hobby tier should reject the deploy with a clear error or downgrade the cron schedule with a warning. It does neither — the deploy "succeeds" but the new code does not run.
3. **No deploy-validation hook.** Our CI does not validate `vercel.json` against the deployment tier before push.

## Remediation (done)

- ✅ Removed `crons` block from `vercel.json` (commit `a20a9c1`)
- ✅ Renamed `CRON_SECRET` → `MONITOR_CRON_SECRET` for clarity (commit `a20a9c1`)
- ✅ Created Cloudflare Worker `monitor-tick-cron/` to schedule per-minute POSTs to `/api/monitor/tick` (commit `08ce21b`)
- ✅ Worker authenticates with bearer `MONITOR_CRON_SECRET`
- ✅ Validated empirically: 13 consecutive ticks observed via `wrangler tail` and KV state confirms tickCount = 13 at validation

## Remediation (pending)

- ⏳ Move Worker from `workers.dev` subdomain to `teraswap.app` route (Prompt 27.8) — eliminates exposed subdomain
- ⏳ Revoke `CLOUDFLARE_API_TOKEN` after Worker stable for 7 days
- ⏳ Add CI guardrail: lint `vercel.json` against tier capabilities (reject sub-daily cron on Hobby)
- ⏳ ADR-003 documents the architectural decision (Cloudflare Worker over Vercel Cron)

## Lessons learned

1. **Tier limits must be encoded as guardrails.** Don't trust the platform to reject invalid configs — write a pre-commit lint that does it.
2. **"Deploy succeeded" is not the same as "code is running".** Always verify deployment by hitting the new code path, not by reading the deploy status.
3. **Use the right tool for cadence.** Per-minute scheduling is a Cloudflare Workers strength (free tier handles it), not a Vercel one. Mix-and-match across providers is fine when justified — see ADR-003.
4. **Bearer-secret separation by purpose.** Renaming `CRON_SECRET` → `MONITOR_CRON_SECRET` clarifies blast radius and key rotation scope. Avoid generic secret names.

## Related

- See also: `Audits/Incidents/2026-04-14-002-ratelimit-misconfigured.md` (same session, different infra)
- See also: `Audits/Incidents/2026-04-15-002-c01-inmemory-state.md` (this incident masked the C-01 fix)
- ADR: `docs/ADR/ADR-003-cloudflare-worker-scheduler.md`
- Runbook: `docs/Runbooks/worker-deployment.md`

## Owner

TeraHash (founder/architect). Sprint 5A.
