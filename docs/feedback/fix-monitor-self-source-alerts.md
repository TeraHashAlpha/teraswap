# Feedback — fix/monitor-self-source-alerts (base d8d658c)

Tasks: [x] 1 recon · [x] 2 state machine + server-RPC probe · [x] 3 cadence + CoW · [x] 4 alerts + daily audit · [x] 5 verify + compare link

**Owner answers (supersede goal text):** Worker stays 60 s, quorum 5→15 ticks; fix state machine AND add a server-RPC probe. **Deviation:** on-chain scan stays every 5th tick (15 breaks `minRequiredBlocksPerScan`: Base 900 vs cap 500, Arbitrum 7200 vs 3000, and needs wider `eth_getLogs` on possibly public RPCs).

## 1. Recon (before the change)
- `teraswap-self` is a liveness probe, not an adapter: `HEAD https://www.teraswap.app/`, 8 s (`monitored-endpoints.ts:20`, `health-check.ts:46-58`). No pair/chain/RPC. Failure = throw/abort OR status outside 200-399 (`:58`). Nothing quotes through that id, so its `pre-seeded OPEN` breaker (`circuit-breaker.ts:292-299`) hid nothing; the same mechanism does hide real degraded sources.
- Disable at 3 consecutive failures = 3 min at 60 s ticks (`source-thresholds.json`, `source-state-machine.ts:313,320`). Cause of the 29 Oct 15:52 failures is **not in the repo** (prod logs out of scope); not the RPC window (probe uses no RPC; 15:52 < 16:00). Check Vercel logs for the HEAD status/timeout.
- Recovery was a blind flip after 10 min with no probe (`:348-368`, `:146`), then re-degrade in 2 ticks (flapping). Tick = 9 HEAD/GET probes + keeper health every tick; every 5th: quorum (2 pairs, mainnet) + on-chain scan.
- CoW loop: 429 → 300 s cooldown (`circuit-breaker.ts:54`) = 5 ticks, so the quorum was the HALF_OPEN probe each cycle; cow sent no Retry-After. Nothing probed the server RPC.

## 2. State machine (`source-state-machine.recovery.test.ts` 12 tests; `health-check.test.ts` 4; `rpc-health.test.ts` 8)
ok→degraded→disabled→degraded→active with no human and no blind timer; failed re-probe stays disabled; 30 infra errors keep it active (no latency poison); infra doesn't extend/reset a streak; one `probe-infra-failure` alert per 10-streak; 8 failures in 8 s can't disable (5 min window); forceDisable/quorum-disabled keep old recovery; aggregators unchanged; re-probe throttled to 3 ticks. Thresholds: self 2/5 + 5 min window; `server-rpc` 2/4.

## 3. Cadence / CoW (`quorum-check.test.ts` +4, `cow.test.ts` +4)
Fires on 15, 30 only; OPEN breakers passed as `excludeSources` on both pairs; **not** half-opened even 301 s after a 429; per-chain breakers not mixed; cow 429 `Retry-After: 45` → `retryAfterMs=45000` → breaker cooldown ≤45 s; HTTP-date/absent header ignored. **Worker change: none** (`wrangler.toml:13` stays `* * * * *`; no Cloudflare action). Raising it would stale the 180 s heartbeat and page the watchdog every 5 min.

## 4. Alerts
Before: unconfigured sender = `console.warn` x3 per alert, "N/3 delivered" counted skips, daily report silent. After: one `[ALERT] no delivery channel configured …` per tick (lock-skipped ticks silent), `alertsConfigured` in tick result, `GET/POST /api/monitor/alerts` (MONITOR_SECRET; booleans/env names only; test-fire throttled 30 s; 9 route + 4 status tests), daily report row `alerts: OK | NOT CONFIGURED | UNKNOWN` (composer run for all 3 states; WARNING). Runbook `docs/Runbooks/MONITORING-ALERTS.md` (+67): `DISCORD_WEBHOOK_URL`, `RESEND_API_KEY`, `ALERT_EMAIL_TO`, Telegram pair, curl test-fire.

## 5. Audit schedule
`security-audit.yml`: `- cron: "0 8 * * 1"` → `+ cron: "23 6 * * *"` (daily 06:23 UTC; push/PR/dispatch kept).

## 6. Verify
vitest 392 files / **6229** pass (origin/main 387 / 6179, +50); lint **93 = 93**; tsc clean; `next build` clean. `git diff --stat origin/main...HEAD`: 24 files, +1155/−34 (before this file's final edit); nothing under `src/ui`, rpc-env, keeper, swap/DCA, ranking. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/monitor-self-source-alerts

## Owner follow-ups
- **Set a channel + test-fire** (nothing here pages anyone until you do). Telegram's prod state is unknown to me.
- Daily report shows `alerts: UNKNOWN` until this deploys. `/status` shows raw `server-rpc:<id>` rows (no `SOURCE_LABELS`, left alone).
- Pre-existing: `teraswap-self` counts toward `MIN_ACTIVE_SOURCES`; `initFromKV` still pre-opens breakers for degraded real sources.
