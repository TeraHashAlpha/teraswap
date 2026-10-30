# Feedback — fix/monitor-self-source-alerts

Tasks: [x] 1 recon · [ ] 2 self-source/breaker state machine · [ ] 3 cadence + CoW · [ ] 4 alerts + daily audit · [ ] 5 verify + compare link

## 1. Recon (file:line, base d8d658c)
- **`teraswap-self` is not an adapter/quote source.** It is a site-liveness probe in `MONITORED_ENDPOINTS` (`monitored-endpoints.ts:20`): `HEAD https://www.teraswap.app/`, 8 s timeout (`health-check.ts:46-58`, `:17`). No pair, no chain, no RPC. Only 2 non-test refs exist in src/ (this + `health-check.ts:32`); no adapter has that name, so the `[CB] teraswap-self: pre-seeded OPEN` line is a breaker nobody calls (`circuit-breaker.ts:292-299` opens a breaker for *any* non-active id). Users did not lose a source via `teraswap-self`; the same mechanism DOES hide real degraded/disabled sources.
- **Failure** = fetch throws/aborts (timeout, DNS, reset) OR status outside 200-399 (`health-check.ts:58`). Aggregators: only throw or 5xx (`:94`).
- **Thresholds** (`source-thresholds.json`): self degrades at 2 consecutive failures, disables at 3 (`source-state-machine.ts:313,320`). At 60 s ticks that is **3 minutes** of failed HEADs. Matches the log `degraded → disabled (3 consecutive failures)`.
- **Why 29 Oct 15:52:** not determinable from the repo (prod logs are out of read scope). It cannot be the RPC allowlist: the probe touches no RPC, and 15:52 precedes the 16:00 RPC window. Candidates: deploy/cold-start window around #628, edge 4xx/5xx on `HEAD /`, 8 s self-fetch timeout. Unverified.
- **Recovery:** `recordHealthCheck` never leaves `disabled` on success (`:297-306` only handles degraded). Only `checkAutoRecovery` (`:348-368`) flips non-P0 disabled → active **blindly after 10 min** (`:146`), with no probe; if still broken it re-degrades in 2 ticks and re-disables in 3 (flapping, fresh alerts). P0 reasons never recover without a human.
- **Tick per run:** `MONITORED_ENDPOINTS` (9 hosts) probed every tick (`monitoring-loop.ts:200`) regardless of state; keeper health per chain every tick (`:216`); TLS/DNS only if a baseline exists (`:229`, else skipped); every 5th tick (`quorum-check.ts:116,124`): quorum = `fetchMetaQuote` x 2 pairs, mainnet only (`:257`), + on-chain scan (`on-chain-monitor.ts` same gate).
- **CoW loop:** 429 opens the breaker for `rateLimitCooldownMs` = 300 s (`circuit-breaker.ts:54,180`). Quorum fires every 5 x 60 s = 300 s, so `isOpen()` flips OPEN → HALF_OPEN (`:139`) exactly when the quorum calls, and the probe draws the next 429. cowswap's adapter sends no `retryAfterMs=` so Retry-After is never honoured (`:85`, only zerox does).
- **Alerts:** each channel just `console.warn`s when unconfigured (`discord.ts:40`, `email.ts:26`, `telegram.ts:61`); `alert-wrapper.ts:321` still logs "N/3 delivered". Telegram is the primary channel; its env state in prod is unknown to me.

## Premise deltas (owner decision requested)
1. **"5-min tick"**: the tick is **60 s** (`wrangler.toml:13`, ADR-003). 5 min is the quorum/on-chain cadence. A 15-min Worker breaks the dead-man's switch: heartbeat stale at 180 s (`heartbeat/route.ts:17`) makes the 5-min watchdog fail permanently; every tick would also count as warmup (`monitoring-loop.ts:74`) and 3 failures would mean 45 min.
2. **`teraswap-self` is RPC/pair/chain based**: it is not (see above). The 19 h server-RPC outage was invisible because **nothing probes the server RPC** (keeper-health failures are `console.warn` only), independent of alert channels.

## Plan
- C2: infra vs source split in `HealthCheckResult` (transport errors on the self probe are infra: no failureCount), disable needs N failures AND a minimum failing window, verified recovery disabled → degraded → active on probe successes replaces the blind 10-min flip. Tests.
- C3: per owner answer on cadence; skip OPEN breakers in quorum, honour Retry-After. Tests.
- C4: one `[ALERT] no delivery channel configured` line per run, "alerts: NOT CONFIGURED" in the daily report, runbook + test-fire, `security-audit.yml` daily cron (today weekly `0 8 * * 1`, `:9`).
