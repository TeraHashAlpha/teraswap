# Monitoring alerts — delivery, test-fire, and what the monitor now does

Owner-facing. Env var **names** only; never paste values into this repo, a PR or a chat.

## Why this exists

On 2026-10-29/30 the server RPC failed for ~19 h and nobody was told: no alert channel was configured (each
sender just logs `[ALERT:<channel>] … not set — skipping`), and nothing probed the server RPC. Both are now
visible, but **a human still has to set at least one channel.**

## 1. Delivery channels (Vercel → Project → Settings → Environment Variables → Production)

A channel works only when **all** of its variables are set. One working channel is enough.

| Channel | Variables (all required) | Notes |
|---|---|---|
| Telegram (primary, with inline buttons) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `@teraswap_monitor_bot` |
| Discord | `DISCORD_WEBHOOK_URL` | must start `https://discord.com/api/webhooks/` or `https://discordapp.com/api/webhooks/` |
| Email (Resend) | `RESEND_API_KEY`, `ALERT_EMAIL_TO` | sender is `alerts@teraswap.app` |

Also used, separately: `MONITOR_SECRET` (Bearer for `/api/monitor/*` admin routes and the daily report),
`MONITOR_CRON_SECRET` (the Cloudflare Worker → tick), and the **GitHub** secret `WATCHDOG_ALERT_WEBHOOK`
(the 5-min heartbeat watchdog alerts through this, independent of the app).

Redeploy after changing env vars (Vercel applies them to new deployments only).

## 2. Check status, then test-fire once

Both calls need `Authorization: Bearer $MONITOR_SECRET` (use your shell's own variable; do not inline the value).

```bash
# Which channels are configured? (booleans + env names, never values)
curl -s -H "Authorization: Bearer $MONITOR_SECRET" https://www.teraswap.app/api/monitor/alerts
#   → {"status":"OK"|"NOT CONFIGURED","channels":{"telegram":…,"email":…,"discord":…},"envNames":{…}}

# Send ONE clearly labelled test alert through every configured channel (throttled to 1 per 30 s)
curl -s -X POST -H "Authorization: Bearer $MONITOR_SECRET" https://www.teraswap.app/api/monitor/alerts
#   → {"ok":true,"results":{"telegram":"sent","email":"skipped (not configured)","discord":"skipped (not configured)"}}
```

`sent` means the provider accepted it — confirm it actually arrived in the chat/inbox. `failed` = wrong
token/URL/key (check Vercel logs for `[ALERT:test]`). `ok:false` with everything skipped = nothing configured.

## 3. How you find out it is broken (no more silence)

- **Every tick** with zero channels configured logs exactly one line:
  `[ALERT] no delivery channel configured — alerts are NOT reaching anyone …` (search Vercel logs for `[ALERT] no delivery`).
  The tick response also carries `alertsConfigured:false`.
- **Daily health report** (`Audits/Daily/health-<date>-gha.md`) has an `Alerts` row: `alerts: OK`,
  `alerts: NOT CONFIGURED` (status WARNING) or `alerts: UNKNOWN` (endpoint unreadable).

## 4. What the monitor does now (so alerts mean something)

| Behaviour | Value |
|---|---|
| Tick cadence (Cloudflare Worker, `workers/monitor-tick-cron/wrangler.toml`) | **unchanged, every 60 s** — do not raise it: heartbeat goes stale at 180 s and the 5-min watchdog would page permanently |
| Quorum (`fetchMetaQuote` cross-check) | every **15th** tick (was 5th); sources whose circuit breaker is OPEN are not called |
| On-chain event scan | unchanged, every 5th tick (15 would exceed the per-scan block caps) |
| `teraswap-self` probe | `HEAD https://www.teraswap.app/`; a *transport* error (timeout/DNS/reset) is "infra": it never counts toward degraded/disabled; a persistent run of 10 raises one `probe-infra-failure` alert |
| `teraswap-self` thresholds | degraded after 2 consecutive HTTP failures; **disabled after 5 and ≥ 5 min** |
| Disabled source recovery | re-probed every 3 ticks; one good probe → `degraded`, 3 consecutive → `active`, no human needed. P0 reasons (TLS/DNS change, kill-switch, quorum-correlated) still require a manual reactivate |
| `server-rpc:<chainId>` (chains 1, 8453, 42161) | `eth_blockNumber` through the server resolver every 5th tick; degraded after 2, disabled after 4 failed probes → pages through the same channels (≈ 864 RPC calls/day total) |
| CoW `429` | honours the upstream `Retry-After`; otherwise the fixed 5-min back-off. The monitor never half-opens a backing-off source |

## 5. If alerts are flooding

Use the existing grace mechanism (`MONITOR_GRACE_UNTIL`, Telegram `/grace <minutes>`); P0 alerts bypass it by design.
