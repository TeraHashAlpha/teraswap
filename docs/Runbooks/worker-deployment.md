# Runbook — Cloudflare Worker (`monitor-tick-cron`) deployment & operations

**Scope:** deploying, updating, monitoring, and rotating secrets for the Cloudflare Worker that drives the per-minute monitoring tick. See ADR-003 for architectural context.

**Audience:** founder, on-call engineer.

**Worker location:** `workers/monitor-tick-cron/`

---

## 1. Prerequisites

One-time setup:

```bash
# Install Wrangler globally (or use npx)
npm install -g wrangler

# Authenticate (one of two methods):

# Method A — OAuth (preferred when working)
wrangler login

# Method B — API token (fallback when OAuth is broken; e.g., during Cloudflare incidents)
# Create token at: https://dash.cloudflare.com/profile/api-tokens
# Template: "Edit Cloudflare Workers"
export CLOUDFLARE_API_TOKEN="..."
```

⚠️ If using Method B, **revoke the token** after deployment is stable (max 7 days). Long-lived API tokens are a higher-risk credential than the OAuth session.

---

## 2. First-time deploy

```bash
cd workers/monitor-tick-cron

# Set the bearer secret (must match Vercel env var MONITOR_CRON_SECRET)
wrangler secret put MONITOR_CRON_SECRET
# Paste the same value used in Vercel; press Enter

# Deploy
wrangler deploy
```

Wrangler will prompt to either:
- (a) register a `workers.dev` subdomain for the account, or
- (b) configure a route on a Cloudflare-managed zone.

**Currently:** option (a). The Worker lives at `https://monitor-tick-cron.<account>.workers.dev/`. The `/trigger` route is bearer-protected; the rest returns 404. Acceptable interim risk; tracked in ADR-003 § Negative consequences.

**Post-Cloudflare-Registrar (after ADR-002 migration):** switch to option (b) via Prompt 27.8 — set `routes = ["cron.teraswap.app/*"]` in `wrangler.toml` and remove `workers_dev = true`.

---

## 3. Updating the Worker

```bash
cd workers/monitor-tick-cron

# After editing src/index.ts or wrangler.toml:
wrangler deploy
```

Watch the deploy logs — should end with `Published monitor-tick-cron (X.XX sec)` and the URL/route.

---

## 4. Monitoring

### Live tail logs

```bash
cd workers/monitor-tick-cron
wrangler tail
```

Expected output every 60s:
```
[2026-04-15T00:16:40.123Z] [tick] ok status=200
[2026-04-15T00:17:40.456Z] [tick] ok status=200
```

If you see `status=401` or `status=403`: bearer secret mismatch — see § 6 (rotation).
If you see `status=500` / `status=504`: Vercel function failing — check Vercel function logs.
If you see no output: Worker not running — see § 5.

### Verify cron trigger is registered

```bash
wrangler triggers
```

Should list `* * * * *` for `monitor-tick-cron`.

### Verify the bearer is set

```bash
wrangler secret list
```

Should include `MONITOR_CRON_SECRET`. Values are not retrievable — only set/delete.

---

## 5. Common failures

### 5.1. Worker not deployed / stopped

**Symptom:** `wrangler tail` produces no output for >2 min; `tickCount` in KV not incrementing.

**Fix:**
```bash
cd workers/monitor-tick-cron
wrangler deploy
wrangler tail
```

If deploy fails, check the error. Common causes:
- Auth expired → `wrangler login` again.
- API token revoked → re-issue and re-export `CLOUDFLARE_API_TOKEN`.
- Cloudflare incident → check https://www.cloudflarestatus.com.

### 5.2. 401 Unauthorized in tail logs

**Symptom:** `[tick] failed status=401`

**Diagnosis:** the bearer token in the Worker secret doesn't match what Vercel expects.

**Fix:**
1. Get the canonical value from Vercel: Dashboard → Settings → Environment Variables → `MONITOR_CRON_SECRET` → reveal.
2. Update the Worker secret:
   ```bash
   cd workers/monitor-tick-cron
   wrangler secret put MONITOR_CRON_SECRET
   # paste the canonical value
   ```
3. Verify next tick within 60s shows `status=200`.

### 5.3. 500 / 504 Vercel errors

**Symptom:** `[tick] failed status=500` or `status=504`

**Diagnosis:** Vercel function is failing. Worker is fine.

**Fix:** see Vercel function logs. Most common: KV unavailable (see `docs/Runbooks/KV-troubleshooting.md`) or unhandled exception in `monitoring-loop.ts`.

### 5.4. OAuth login broken

**Symptom:** `wrangler login` returns "Application authorization failed" or browser auth fails.

**Diagnosis:** Cloudflare incident affecting OAuth flow (we hit this on 2026-04-14 during Container Scheduling Delays incident).

**Workaround:** use API token authentication (Method B in § 1).

---

## 6. Secret rotation

Rotate `MONITOR_CRON_SECRET` quarterly OR immediately after suspected exposure.

```bash
# 1. Generate new secret (32 random bytes, base64)
NEW_SECRET=$(openssl rand -base64 32)

# 2. Update Vercel first (so the validator accepts the new value)
#    Vercel Dashboard → Settings → Environment Variables → MONITOR_CRON_SECRET → Edit
#    Paste $NEW_SECRET → Save → Trigger redeploy

# 3. Wait ~90s for redeploy to be Ready

# 4. Update Worker
cd workers/monitor-tick-cron
wrangler secret put MONITOR_CRON_SECRET
# paste $NEW_SECRET

# 5. Watch tail for next tick — should be status=200 within 60s
wrangler tail
```

⚠️ Rotation order matters. Update Vercel first; otherwise the Worker will be sending the new value while Vercel still expects the old one, causing 401s for ~90s.

---

## 7. Migrating Worker route (Prompt 27.8 — post Cloudflare Registrar)

After `teraswap.app` is on Cloudflare DNS:

1. Edit `workers/monitor-tick-cron/wrangler.toml`:
   ```toml
   workers_dev = false
   routes = [
     { pattern = "cron.teraswap.app/*", zone_name = "teraswap.app" }
   ]
   ```
2. Add DNS record in Cloudflare for `cron.teraswap.app` → CNAME to placeholder (Cloudflare proxy = orange cloud).
3. Deploy: `wrangler deploy`.
4. Verify: `wrangler tail` continues to show ticks.
5. Confirm `https://monitor-tick-cron.<account>.workers.dev/` returns 1101 / inactive.

---

## 8. Decommissioning the Worker

If we ever migrate scheduling back to Vercel Pro Cron (ADR-003 reconsideration trigger):

```bash
cd workers/monitor-tick-cron
wrangler delete
```

Then:
- Re-add `crons` block to `vercel.json`.
- Confirm Vercel Pro tier active.
- Validate first per-minute trigger via Vercel function logs.

---

## 9. Related

- ADR-003 — Cloudflare Worker scheduler decision
- Incident 2026-04-15-001 — Vercel Hobby cron rejection (the trigger for this Worker)
- Runbook `docs/Runbooks/KV-troubleshooting.md`
- Worker source: `workers/monitor-tick-cron/src/index.ts`
- Worker config: `workers/monitor-tick-cron/wrangler.toml`
