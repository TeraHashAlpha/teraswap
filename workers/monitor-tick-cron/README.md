# TeraSwap Monitor Tick Cron — Cloudflare Worker

## Purpose

Per-minute scheduler that POSTs to `https://teraswap.app/api/monitor/tick` with a shared bearer secret. Runs on Cloudflare Workers free tier (100k req/day, 1,440 needed). Independent of Vercel — if Vercel is down, the Worker still runs and failures surface in `wrangler tail`.

## Prerequisites

- Node.js 20+
- Cloudflare account (free tier works)
- `wrangler` CLI: `npm install -g wrangler`
- API token with **Workers Scripts:Edit** permission

## Setup

```bash
cd workers/monitor-tick-cron
npm install
wrangler login  # Authenticates via browser
```

## Set the shared secret

Generate the secret (same value must be set in Vercel env as `MONITOR_CRON_SECRET`):

```bash
openssl rand -hex 32
# Copy the output

npm run secret:set
# Paste the value when prompted
```

## Deploy

```bash
npm run deploy
```

## Verify

```bash
npm run tail
# Wait up to 60s — you should see:
# [tick] ok status=200 elapsed=XXXms
```

## Secret rotation

1. Generate new secret: `openssl rand -hex 32`
2. Update Cloudflare: `npm run secret:set` (paste new value)
3. Update Vercel: Dashboard → Settings → Environment Variables → `MONITOR_CRON_SECRET`
4. Redeploy Vercel (or wait for next push)
5. Verify: `npm run tail` should show `status=200`

## Routes

The Worker is bound to `teraswap.app/_cron/*` (the default `*.workers.dev` URL is disabled).

| Path | Method | Auth | Description |
|------|--------|------|-------------|
| `/_cron/trigger` | POST | Bearer | Manual tick trigger |
| `/_cron/health` | GET | — | Health check (JSON) |

## Manual trigger

```bash
curl -X POST https://teraswap.app/_cron/trigger \
  -H "Authorization: Bearer <MONITOR_CRON_SECRET>"
```

## Health check

```bash
curl https://teraswap.app/_cron/health
# {"status":"ok","worker":"teraswap-monitor-tick-cron","ts":...}
```
