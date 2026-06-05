# Runbook — Rate-limiter verification

**Scope:** verify that `src/lib/kv-rate-limiter.ts` is functional end-to-end after any infrastructure change (KV migration, env var rotation, Vercel project relink). Designed to prevent a recurrence of incident `2026-04-14-002` (13-day silent failure).

**Audience:** founder, on-call engineer.

**Frequency:** every infrastructure change touching KV or Vercel project config; quarterly anyway.

---

## 1. Pre-flight: confirm KV is alive

Run § 1 of `docs/Runbooks/KV-troubleshooting.md` first. The rate-limiter cannot work if KV is down — verifying the rate-limiter when KV is broken produces noise.

If KV health-check passes, proceed.

---

## 2. End-to-end rate-limit test (manual)

The rate-limiter caps per-IP requests at the `/api/quote` endpoint at the configured threshold (currently 60 req/min, defined in `src/lib/kv-rate-limiter.ts`).

### 2.1. From a fresh terminal

```bash
# Hit /api/quote 65 times rapidly from the same IP
for i in $(seq 1 65); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://teraswap.app/api/quote?fromToken=USDC&toToken=USDT&amount=1000000"
done | sort | uniq -c
```

**Expected output (rate-limiter working):**
```
  60 200
   5 429
```

(60 successful, 5 rate-limited at the end.)

**Failure mode (rate-limiter NOT working — incident `2026-04-14-002` style):**
```
  65 200
```
All 65 succeed → no rate-limiting → ROOT CAUSE in § 4.

### 2.2. Verify counter in KV

After running § 2.1, immediately:

```bash
# Replace <YOUR_IP> with the IP you tested from (your public IP)
curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
  "$KV_REST_API_URL/get/teraswap:ratelimit:<YOUR_IP>"
```

Should return a counter ≥ 60 (with TTL on the rolling window).

If the key doesn't exist after 65 requests → the rate-limiter is not writing to KV. Root cause likely in § 4.

---

## 3. CI-style smoke test (recommended, not yet implemented)

Pending: `tests/integration/rate-limiter.test.ts`. The script should:

1. Hit a test endpoint N+1 times where N = limit.
2. Assert: first N return 200; (N+1)-th returns 429.
3. Assert: KV counter incremented to N+1.
4. Reset (delete the test key).
5. Run on every PR via GitHub Actions.

Until implemented, run § 2 manually after every KV/Vercel infra change.

---

## 4. Common root causes when rate-limiter doesn't work

### 4.1. Wrong KV backend (Redis Cloud instead of Upstash)

**Diagnosis:** Vercel Storage tab shows `teraswap-ratelimit` (Redis Cloud) instead of `teraswap-kv` (Upstash). `@vercel/kv` cannot speak to Redis Cloud's TCP protocol. Silent fail-open.

**Fix:**
1. Vercel Dashboard → Storage → Disconnect old Redis Cloud database.
2. If Upstash database doesn't exist yet, create one: Storage → Browse Marketplace → Upstash → Create database `teraswap-kv` (region: closest to your Vercel deployment).
3. Connect `teraswap-kv` to the Vercel project — should auto-populate 5 env vars.
4. Verify env vars exist: Settings → Environment Variables → search "KV". Should see `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_REDIS_URL`. All Environments.
5. Redeploy: Deployments → ⋯ → Redeploy without build cache.
6. Re-run § 2.

### 4.2. Env vars missing or empty

**Diagnosis:** § 1 health check fails (no env vars from `vercel env pull`). Production logs show `@vercel/kv` errors thrown but swallowed.

**Fix:** see § 4.1 from step 4 onwards.

### 4.3. Rate-limiter code not in current build

**Diagnosis:** § 2 returns all 200s, but `tests/unit/rate-limiter.test.ts` passes locally.

**Fix:** the rate-limiter middleware isn't being invoked. Check:
- `src/middleware.ts` exists and matches `/api/quote*`.
- `next.config.js` doesn't exclude middleware.
- The deployed commit actually contains the rate-limiter code (`git log` vs Vercel deploy commit hash).

### 4.4. Counter increments but no 429 returned

**Diagnosis:** § 2.2 shows counter going up, but § 2.1 returns all 200s.

**Fix:** the threshold comparison logic is broken. Inspect `src/lib/kv-rate-limiter.ts` — likely a stale threshold constant or a sign error in the comparison.

---

## 5. Operational metrics to watch

- **`@vercel/kv` error rate** — should be 0%. If >1% sustained over 5 min, alert (Sentry rule pending implementation).
- **429 rate** — baseline depends on traffic; sudden spike to >5% suggests a bot or misconfigured client.
- **Counter values per IP** — top-N consumers list useful for capacity planning and abuse detection.

---

## 6. Why this runbook exists

Incident `2026-04-14-002`: the rate-limiter was silently broken for 13 days because:
1. Code: `import { kv } from '@vercel/kv'` (HTTP REST client).
2. Backend: Redis Cloud (TCP-only).
3. Wire incompatibility → every KV call threw → caught silently → fail-open returned `allow`.

No alert fired. No tests covered the integration. Discovered by accident.

This runbook codifies the verification step that should have caught it on day 1.

---

## 7. Related

- ADR-004 — Upstash backend choice (the post-incident decision)
- Incident 2026-04-14-002 — full post-mortem
- Runbook `docs/Runbooks/KV-troubleshooting.md`
- `src/lib/kv-rate-limiter.ts` — code under test
