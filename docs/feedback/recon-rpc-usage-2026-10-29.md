# Feedback — recon/rpc-usage (2026-10-29, origin/main 2c0849c, READ-ONLY)

Env NAMES only; no URL or key was read or printed. Every number below is **modelled from code, not measured** — I read no Vercel env, no logs, no dashboard beyond the owner's figures.

**Owner decisions recorded.** (1) Premise false: `scripts/feeds/`, `src/lib/chain-verify*`/`order-floor*`, keeper `keeper*.js`/`config*`/`lib/` match nothing → owner chose "widen to intent" (all non-test `executor/*.js`, `src/lib/chains/**`, `scripts/dca-feeds/**`, workflow cron lines, `monitoring-loop` + monitor libs, `adapters/**`). (2) Owner data: key `teraswap-mainnet-v2` = 358.9K req/24h (>90% `eth_call`), bursts of 30–45K about every 2 h; `teraswap-keeper-arbitrum` = 1.2K/day; Oct 24–25 = 0 on all networks.

## Verdict
- **No scheduled job in the repo has a ~2 h cadence or produces 30–45K `eth_call`.** Schedules found: CF Worker `* * * * *` → `/api/monitor/tick` (`workers/monitor-tick-cron/wrangler.toml`); GHA watchdog `*/5` (HTTP only); daily-health 08:00 UTC (2 `eth_getBalance`); token-catalog Mon 06:00 and CodeQL/audit weekly; **`vercel.json` has no `crons`**. The tick is a flat ~0.6K/day on mainnet. Irregular 16/20/22/01/05/07/12 h bursts look like **traffic, not cron**.
- **Fixed non-user load on all keys ≈ 8K calls/day** (tick + keepers idle + catalog avg + GHA). The other ≥350K/day on mainnet-v2 is browser/API/external-driven.
- **Bursts need ~8–12 `eth_call`/s.** Reachable by one IP: `/api/rpc` limit is 300 *HTTP* req/min but a batch holds ≤25 calls and is counted once → **≤7,500 calls/min/IP** (45K in 6 min) (`route.ts:75,97`, `kv-rate-limiter.ts:36`). `/api/quote` allows 30/min/IP, each miss = 1–6 `eth_call` (cache 12 s vs 15 s client refresh → a varied-amount script always misses).
- **Likely-public key.** `NEXT_PUBLIC_RPC_URL` is `required: true` as "Primary RPC URL (Alchemy/Infura)" (`env-validation.ts:21`) and is read in client-reachable modules (`wagmiConfig.ts:26`, `rpc.ts:18`, `chains/registry.ts:42`) → Next inlines it into the browser bundle. Base/Arbitrum browsers call `NEXT_PUBLIC_BASE_RPC_URL`/`NEXT_PUBLIC_ARBITRUM_RPC_URL` directly (`wagmiConfig.ts:131,134`). **Unverified**: I did not check which key those env hold. If mainnet-v2 is one of them, anyone can replay it with no rate limit; Alchemy origin allowlist is spoofable from scripts.
- **Oct 24–25 zero:** nothing deployed/stopped in repo — only auto health-report commits between 10-24 00:31 and 10-25 22:30; both reports show site/`/api/health`/`/api/monitor` 200 and keeper gas unchanged. A live tick (1,440/day) + Arbitrum keeper (~1.2K/day) cannot meter zero → suspect a **dashboard filter/gap**, or the tick/keeper host stopped (EC2 PM2 logs / CF Worker logs decide; not visible from the repo).
- **Wagmi:** `batch.multicall` ON (default, not overridden); no `watch:`/`useWatch*`; QueryClient defaults (`providers.tsx:44`: staleTime 0, refetch on focus/mount); hidden tabs pause `refetchInterval` (RQ default; Footer sets it explicitly), but `usePortfolio` `setInterval`s (`:193,:416`, HTTP) do not.

## Inventory (one table) — "tab-day" = one visible tab open 24 h; hidden tabs ≈ 0
| # | Path | Trigger · rate | Method · calls/trigger | Est. calls/day | Chain | Provider env (name) |
|---|---|---|---|---|---|---|
| 1 | Footer `useBlockNumber` (v1 `Footer.tsx:13,38`, v2 `ui/v2/shell/Footer.tsx:13`) — **runs for wallet-less visitors** | every 12 s, visible tab | `eth_blockNumber` ×1 | 7,200 /tab | selected | mainnet via `/api/rpc`; L2 direct `NEXT_PUBLIC_BASE_RPC_URL`/`NEXT_PUBLIC_ARBITRUM_RPC_URL` |
| 2 | `useChainlinkPrice` ×2 (`:204-209`; SwapBox, v2 SwapCard) — wallet-less too | 30 s | `eth_call` latestRoundData+decimals+description per leg (multicall-merged only if same tick) | 2,880–17,280 /tab | selected | same as 1 |
| 3 | `useDepegCheck:61` (Limit/Conditional panels, v2 `use-swap-gates.ts:50`) | 30 s, only registered pairs | `eth_call` ×1–4 | 0 / 2,880–11,520 /tab | selected | same |
| 4 | Balances: `useTokenBalances:65`, `useTokenBalance:47`, `usePortfolio:297` (wallet connected) | 30 s | `eth_getBalance` ×1 + multicall `eth_call` ×1 | 5,760–8,640 /tab | selected | same |
| 5 | `/api/rpc` proxy (`route.ts`) — all browser mainnet reads, no cache | any request | pass-through, batch ≤25 | ≤7,500/min/IP worst case | 1/8453/42161 (`?chainId`) | `RPC_URL`‖`NEXT_PUBLIC_RPC_URL` (mainnet); registry URL for L2 |
| 6 | `/api/quote`, `/api/v1/quote` → Uniswap V3 + Curve adapters (`uniswapv3.ts:97-170`, `curve.ts:185,248`) | UI refresh 15 s/visible tab with amount; ≤30/min/IP; KV cache 12 s | `eth_call` QuoterV2 ×4 cold (fee tier cached 45 min/instance) or ×1 warm, +Curve ×1–2 | 8.6K–34K /tab; ≤43K quotes/IP | 1 (+ L2 via registry) | `RPC_URL`‖`NEXT_PUBLIC_RPC_URL` (`adapters/shared.ts:101`) |
| 7 | `/api/swap-price-tier`, `/api/swap`, `/api/orders`, `/api/dca-floor-cap`, `/api/oracle-coverage`, `/api/log-swap` (Chainlink/token reads) | pair change / user action; tier cached 30 s in-memory per instance | `eth_call` ×2–6 (+identity ×2/feed per cold instance) | low (hundreds) | per request | same as 6 |
| 8 | Monitor tick (`monitoring-loop.ts:208-285`, `keeper-health-monitor.ts:107`, `on-chain-monitor.ts:343,809`) | CF Worker every 60 s = 1,440/day | `eth_getBalance` Base+Arb **every tick**; every 5th: `eth_blockNumber`+`eth_getLogs` ×3 chains | mainnet ~576; Base ~2,016; Arb ~2,016 | 1/8453/42161 | mainnet `RPC_URL`‖`NEXT_PUBLIC_RPC_URL`; L2 `NEXT_PUBLIC_BASE_RPC_URL`/`NEXT_PUBLIC_ARBITRUM_RPC_URL` |
| 9 | Base keeper `teraswap-executor` (`executor.js`, `idle-backoff.js`) | 30 s while ≥1 active order, else 300 s | ~6/cycle (2 getBalance, blockNumber, ETH/USD call, getLogs/contract) +2/order | idle ~1.4K; active (6+2N)×2,880 (N=5 ≈ 46K) | 8453 | `RPC_URL` in `.env.executor` |
| 10 | Arbitrum keeper `teraswap-keeper-arbitrum` | same, idle | same | ~1.2K (owner, matches model) | 42161 | `RPC_URL` in `.env.executor.arbitrum` |
| 11 | Keeper boot / PM2 crash loop | per start; `restart_delay` 5 s, `max_restarts` 50 | eth_chainId, eth_getCode, whitelist `eth_call`, getBalance ≈ 5–8 | ≤400 total then PM2 stops | own | own |
| 12 | GHA daily-health 08:00 UTC; watchdog `*/5` | cron | 2 `eth_getBalance`; watchdog HTTP only | 2 | 8453/42161 | `HEALTH_RPC_URL_BASE`/`HEALTH_RPC_URL_ARBITRUM` |
| 13 | token-catalog-refresh (Mon 06:00) `verdicts.ts` | weekly, concurrency 10 + retries | getCode/symbol/decimals/transfer sim, 987+311+296 rows ×3–5 | ~5–8K/run ≈ 1K/day avg | 1/8453/42161 | `GUARD_RPC_1`/`_8453`/`_42161` (public default; Alchemy only if secrets set) |
| 14 | `scripts/dca-feeds` plan/verify (manual) | owner-run | `eth_call`/`eth_getCode`/`eth_chainId`, retry 2 | 10²–10³/run | per script | per-chain config list |
| – | Not RPC: `usePortfolio` timers → `/api/portfolio/tokens` (`alchemy_getTokenBalances`, s-maxage 30); `LimitOrderPanel:950` → CoW HTTP | — | — | — | — | `ALCHEMY_API_KEY` (server) |

## Top 5 (Alchemy CU: eth_call 26, eth_blockNumber 10, eth_getBalance 19, eth_getLogs 75; 30 d)
1. **Burst traffic on the mainnet URL** (owner data, ~7×37K ≈ 260K/day) ≈ 6.8M CU/day → ~200M CU/mo if daily. Source unproven: row 5, 6 or a scraped key.
2. **Quote adapters (6)**: 8.6K–34K calls/tab-day → 6.7M–26.5M CU/mo per always-open tab; one scripted IP at the 30/min cap → 34M–202M CU/mo.
3. **Chainlink polling (2)**: 2.2M–13.5M CU/mo per tab (decimals/description are immutable yet polled).
4. **Balances (4)**: 3.9M–5.8M CU/mo per connected tab.
5. **Footer block poll (1)**: 2.2M CU/mo per visible tab — and runs without a wallet.
Flagged "polling with no subscriber": tick `getBalance` on every minute for chains whose keeper is idle (~55K CU/day, ~1.7M CU/mo); Chainlink `decimals`/`description` every 30 s; Footer poll for visitors who never connect; `usePortfolio` timers on hidden tabs (HTTP).

## Recommend (no edits made; cheapest first; savings are model estimates)
1. **Split keys in the Alchemy dashboard**: one each for `/api/rpc`, server adapters+tick, Base keeper, Arbitrum keeper (env swap only) → attributes bursts; ~0 CU saved, unlocks the rest.
2. **Verify exposure**: count occurrences of the provider hostname in the deployed JS (count only, never print); if present, point `NEXT_PUBLIC_RPC_URL`/`_BASE_RPC_URL`/`_ARBITRUM_RPC_URL` at a public RPC and keep the paid URL server-only (`RPC_URL`); code touch points `wagmiConfig.ts:26,131,134`, `rpc.ts:18`, `registry.ts:42,84,132`, `env-validation.ts:21`. Saves up to the entire burst volume if confirmed.
3. **Cost-weight `/api/rpc` rate limit** by `requests.length` (`route.ts:75`) or lower `RPC_RATE_LIMIT` (`kv-rate-limiter.ts:36`): worst case 7,500 → ~300 calls/min/IP (25×).
4. **Footer** `FOOTER_BLOCK_POLL_MS` 12 s → 60 s, or skip when no wallet (`Footer.tsx:13`, `ui/v2/shell/Footer.tsx:13`): −80% of row 1 ≈ 1.7M CU/mo/tab.
5. **`useChainlinkPrice.ts:204-209`**: poll only `latestRoundData`, give `decimals`/`description` `staleTime: Infinity`: −0–67% of row 2 (0 if multicall already merges them).
6. **Tick `getBalance` every 5th tick** like the scan (`monitoring-loop.ts:208-215`): −80% ≈ 1.3M CU/mo.
7. **Quote cost**: persist the Uniswap fee tier in KV instead of per-instance memory (`adapters/shared.ts:136-137`, `uniswapv3.ts:247`), and bucket the amount in the cache key / raise TTL ≥ refresh (`meta-quote-cache.ts:35`; key not read): up to −75% cold-start `eth_call` per quote.
8. **`usePortfolio.ts:193,416`**: add `document.hidden` guard like `useQuote.ts:484`/`useOrderExecutions.ts:58` (HTTP, Alchemy enhanced-API CU).
9. Keepers: already idle-backed-off; ask for Base active-order count before touching `executor.js:1132,1205` (double getBalance per active cycle). Move receipt/block polling to a public RPC only for the keeper's `eth_blockNumber`/receipt waits (`executor.js:1885`).

## Not covered / unverified
Which env holds which key; Base order count; `v1/quote` auth; `meta-quote-cache` key shape; multicall tick-alignment; `/api/swap`, `/api/orders` per-request counts (user-action-driven, small); whether the Oct 24–25 zero is real or a dashboard artefact.
