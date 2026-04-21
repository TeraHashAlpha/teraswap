# Runbook — Vercel KV / Upstash troubleshooting

**Scope:** diagnosing and repairing the `teraswap-kv` Upstash Redis database that backs both the rate-limiter and monitoring state. See ADR-004 and ADR-005 for the architectural context.

**Audience:** on-call engineer, founder.

**Primary symptoms covered:**
- Monitoring dashboard shows stale `lastTick`
- `tickCount` not incrementing
- Rate-limiter not enforcing (incident `2026-04-14-002` style)
- `@upstash/redis` calls throwing in production logs

---

## 1. Quick health check (60 seconds)

From the Vercel dashboard or local terminal with project linked:

```bash
# Pull current env vars
vercel env pull .env.local
grep UPSTASH_REDIS_REST .env.local
```

Should show two lines:
```
UPSTASH_REDIS_REST_URL="https://<your-instance>.upstash.io"
UPSTASH_REDIS_REST_TOKEN="..."
```

Export and probe:

```bash
export UPSTASH_REDIS_REST_URL="https://<your-instance>.upstash.io"
export UPSTASH_REDIS_REST_TOKEN="..."

# Heartbeat (should be < 90s old)
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" "$UPSTASH_REDIS_REST_URL/get/teraswap:monitor:lastTick"

# Tick counter (should be > 0 and increasing)
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" "$UPSTASH_REDIS_REST_URL/get/teraswap:monitor:tickCount"

# Source index (should list 10 sources)
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" "$UPSTASH_REDIS_REST_URL/smembers/teraswap:source-state:index"

# Sample source state
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" "$UPSTASH_REDIS_REST_URL/get/teraswap:source-state:balancer"
```

Expected: timestamps fresh, counter increasing minute-by-minute, 10 sources, full `SourceStatus` JSON.

---

## 2. Common failure modes

### 2.1. Env vars missing in Vercel

**Symptom:** `vercel env pull` returns no `UPSTASH_REDIS_REST_*` lines. Production logs show `@upstash/redis` connection errors.

**Diagnosis:** Vercel project not linked to Upstash database, OR the link was disconnected.

**Fix:**
1. Vercel Dashboard → Project → Storage tab.
2. Verify `teraswap-kv` (Upstash) is listed and shows status "Available".
3. If missing or showing different name (e.g., `teraswap-ratelimit`): see § 2.2.
4. If listed but env vars missing: Disconnect and Reconnect. Confirm both vars populated in Settings → Environment Variables (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`).
5. Redeploy (Deployments → ⋯ → Redeploy without build cache).

### 2.2. Wrong backend connected (Redis Cloud instead of Upstash)

**Symptom:** Storage tab shows a Redis Cloud database (`rediss://...:6379`-style); `@upstash/redis` throws "fetch failed" or "Unexpected token <" errors.

**Diagnosis:** This is the root cause of incident `2026-04-14-002`. `@upstash/redis` speaks Upstash REST, not native Redis. Redis Cloud free tier is TCP-only.

**Fix:** see Runbook `docs/Runbooks/rate-limiter-verification.md` — full migration procedure.

### 2.3. Upstash database suspended

**Symptom:** Vercel Storage tab shows status "Suspended" or curls return 401 / "database not found".

**Diagnosis:** Free-tier Upstash databases auto-suspend after extended inactivity OR if usage exceeds free-tier soft caps (10k req/day).

**Fix:**
1. Upstash console → database → click "Resume" (if suspension is due to inactivity).
2. If due to quota: check Usage tab — if sustained over 10k req/day, upgrade to paid (~$10/mo) or shard workloads. See ADR-004 § Reconsideration triggers.
3. Add a synthetic keep-alive to monitoring: every tick already writes `lastTick` and `tickCount`, which prevents inactivity suspension.

### 2.4. Tick counter stuck

**Symptom:** `tickCount` stays at the same value across multiple curls 1+ min apart.

**Diagnosis:** the Worker isn't reaching Vercel, OR Vercel is reaching KV but write fails silently.

**Fix sequence:**
1. Check Worker is running: `cd workers/monitor-tick-cron && wrangler tail`. Should see `[tick] ok status=200` lines every 60s.
2. If Worker silent → see Runbook `docs/Runbooks/worker-deployment.md`.
3. If Worker shows `[tick] ok status=200` but counter doesn't move → Vercel function logs (Vercel Dashboard → Functions → `/api/monitor/tick`). Look for `kv.incr` errors.
4. If Vercel shows KV errors: see § 2.1 or § 2.2.

### 2.5. `lastTick` stale by hours

**Symptom:** `lastTick` is many hours old; `tickCount` not incrementing.

**Diagnosis:** Worker died OR Vercel deployment regressed OR auth bearer mismatch.

**Fix sequence:**
1. `wrangler tail` on the Worker — if logs show 401/403, `MONITOR_CRON_SECRET` mismatch between Worker and Vercel. Re-set with `wrangler secret put MONITOR_CRON_SECRET` to match Vercel env var.
2. If logs show 500/504, Vercel function failing — check Function logs.
3. If Worker is in a deploy-failed state, re-deploy: `wrangler deploy`.

---

## 3. Usage tracking

Upstash free tier: 10,000 req/day, 256MB storage.

**Estimate:** monitoring loop = 10 sources × ~3 KV ops/tick × 1440 ticks/day ≈ 43k worst-case (no per-tick cache hits). With cache: ~14k/day. Rate-limiter adds variable load (~1-3k/day baseline). **Total: ~15-20k/day projected.**

This is **above** the 10k/day soft cap. Action items:
- ⏳ Verify per-tick cache hit ratio (Prompt 28 instrumentation).
- ⏳ Decide between upgrading to paid Upstash ($10/mo) or splitting workloads. ADR-004 reconsideration triggered.

Check usage: Upstash console → `teraswap-kv` → Usage tab → daily request count graph.

---

## 4. Manual repair commands

### Reset the source index

If the index is corrupted:

```bash
# Delete the index (sources will re-add themselves on next tick)
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/del/teraswap:source-state:index"
```

### Force-disable a source (emergency, if Worker is broken)

```bash
# Read current state
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/get/teraswap:source-state:cowswap"

# Write disabled state (requires constructing the JSON manually)
curl -s -X POST -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -d '{"id":"cowswap","state":"disabled","disabledReason":"manual-emergency","disabledAt":1234567890}' \
  "$UPSTASH_REDIS_REST_URL/set/teraswap:source-state:cowswap"
```

⚠️ Prefer the `/api/admin/kill-switch` route (Prompt 29) when available — it audit-logs to Supabase. Direct KV writes are an emergency-only tool.

### Force a tick (for debugging)

```bash
# Direct trigger of the Worker (bypasses cron, useful when investigating timing)
curl -s -X POST \
  -H "Authorization: Bearer $MONITOR_CRON_SECRET" \
  https://monitor-tick-cron.<account>.workers.dev/trigger
```

---

## 5. Escalation

If the above doesn't resolve in 15 minutes:

1. Activate `MONITOR_GRACE_UNTIL` (Vercel env var, ISO timestamp ~1h forward) to suppress alert spam while debugging.
2. Page TeraHash via Telegram (or whatever H6 channel is current).
3. If KV is fully unreachable for >30 min: consider failing over to a stand-by Upstash database (provisioned during disaster recovery — currently not provisioned; tracked).

---

## 6. Related

- ADR-004 — Upstash backend choice
- ADR-005 — State persistence design
- Incident 2026-04-14-002 — rate-limiter silent failure (the original root cause that drove this runbook)
- Runbook `docs/Runbooks/worker-deployment.md`
- Runbook `docs/Runbooks/rate-limiter-verification.md`
