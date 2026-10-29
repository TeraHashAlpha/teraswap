# Feedback — recon/rpc-usage (2026-10-29, origin/main 2c0849c, read-only)

Env NAMES only. All numbers are **modelled from code, not measured** (no Vercel env, logs or dashboard read beyond the owner's figures).
Owner answers recorded: scope widened to intent (`scripts/feeds`, `src/lib/chain-verify*`, `order-floor*`, keeper `keeper*.js`/`config*`/`lib/` matched nothing); dashboard: `teraswap-mainnet-v2` 358.9K/24h (>90% `eth_call`, 30–45K bursts ~2 h), `teraswap-keeper-arbitrum` 1.2K/day, Oct 24–25 = 0.

## Verdict
- **No scheduled job explains the ~2 h bursts.** Only: CF Worker `* * * * *` → `/api/monitor/tick`; GHA watchdog `*/5` (HTTP only); daily-health 08:00 (2 calls); catalog + CodeQL weekly; `vercel.json` has no `crons`. Bursts look like traffic.
- **Total modelled: ≈ 238K calls/day (≈ 8.2K fixed + 5 always-visible quoting tabs × 46K), ~121K/day short of the 358.9K observed** (table Σ row). Matching 358.9K would need ≈ 7.6 such tabs all day, and that still does not fit 30–45K/h bursts (8–12 calls/s). One IP can reach it: `/api/rpc` counts a ≤25-call batch as 1 of 300 req/min → ≤7,500 calls/min/IP (`route.ts:75,97`); `/api/quote` 30/min/IP × 1–6 `eth_call`, cache 12 s < 15 s refresh.
- **Likely-public key (unverified):** `NEXT_PUBLIC_RPC_URL` is `required` as "Alchemy/Infura" (`env-validation.ts:21`) and read in browser modules (`wagmiConfig.ts:26`, `rpc.ts:18`, `registry.ts:42`) → inlined in the bundle; L2 browsers hit `NEXT_PUBLIC_BASE_RPC_URL`/`NEXT_PUBLIC_ARBITRUM_RPC_URL` directly. Which env holds mainnet-v2, and whether keys are shared, is **not determinable from the repo**.
- **Oct 24–25:** no deploy/stop in repo (only auto health commits); both reports show site/health/monitor 200, keeper gas unchanged. Zero is inconsistent with a live tick + keeper → dashboard gap, or tick/keeper host stopped (check PM2/CF logs).
- Wagmi: multicall ON (default), no `watch:`, QueryClient defaults (staleTime 0, refetch on focus); hidden tabs pause `refetchInterval`, but `usePortfolio` timers (HTTP) don't.

| # | Path · trigger | Method · calls | Est. calls/day | Chain | Provider env |
|---|---|---|---|---|---|
| 1 | Footer `useBlockNumber` (`Footer.tsx:13`, v2 same), wallet-less too · 12 s visible | `eth_blockNumber` ×1 | 7,200/tab | sel. | `/api/rpc`→`RPC_URL`‖`NEXT_PUBLIC_RPC_URL`; L2 `NEXT_PUBLIC_{BASE,ARBITRUM}_RPC_URL` |
| 2 | `useChainlinkPrice` ×2 (`:204-209`) · 30 s | `eth_call` 3/leg (merged if same tick) | 2.9K–17.3K/tab | sel. | same |
| 3 | `useDepegCheck:61` (registered pairs only) · 30 s | `eth_call` 1–4 | 0 / 2.9K–11.5K/tab | sel. | same |
| 4 | Balances `useTokenBalances:65`, `useTokenBalance:47`, `usePortfolio:297` · 30 s, wallet | `eth_getBalance`+multicall | 5.8K–8.6K/tab | sel. | same |
| 5 | `/api/rpc` proxy, no cache · any | pass-through, batch ≤25 | ≤7,500/min/IP | 1/8453/42161 | `RPC_URL`‖`NEXT_PUBLIC_RPC_URL`; registry URL (L2) |
| 6 | `/api/quote`, `/api/v1/quote` → UniV3/Curve · 15 s/tab, ≤30/min/IP, KV 12 s | `eth_call` 1–6 | 8.6K–34K/tab | 1 (+L2) | `RPC_URL`‖`NEXT_PUBLIC_RPC_URL` |
| 7 | `/api/swap-price-tier`, `swap`, `orders`, `dca-floor-cap`, `oracle-coverage`, `log-swap` · per action, tier cache 30 s/instance | `eth_call` 2–6 | hundreds | per req | same as 6 |
| 8 | Monitor tick · 1,440/day | getBalance Base+Arb every tick; /5: blockNumber+getLogs ×3 | 576 main + 2,016 Base + 2,016 Arb = 4.6K | 1/8453/42161 | as 1 |
| 9 | Base keeper · 30 s w/ orders, else 300 s | ~6/cycle +2/order | idle 1.4K; N=5 ≈ 46K | 8453 | `RPC_URL` (`.env.executor`) |
| 10 | Arbitrum keeper · idle | same | ~1.2K (owner) | 42161 | `RPC_URL` (`.env.executor.arbitrum`) |
| 11 | Keeper boot / PM2 loop (5 s delay, max 50) | chainId, getCode, whitelist, balance ≈ 5–8 | ≤400 total | own | own |
| 12 | GHA daily-health 08:00 | `eth_getBalance` ×2 | 2 | 8453/42161 | `HEALTH_RPC_URL_BASE`/`_ARBITRUM` |
| 13 | token-catalog weekly, 1.6K rows | getCode/symbol/decimals ×3–5 | ~1K/day avg | 1/8453/42161 | `GUARD_RPC_1`/`_8453`/`_42161` (public default) |
| 14 | `scripts/dca-feeds` manual | `eth_call`/getCode | 10²–10³/run | per script | script config |
| **Σ** | **TOTAL (model)**: fixed rows 8–14 = 8,210 + assumed 5 always-visible quoting tabs × 46K (midpoint of 25K–67K; rows 1–4+6) = 230K | | **≈ 238K calls/day ≈ 6.2M CU/day** (vs 358.9K observed → ~121K/day unexplained) | | |

Not RPC: `usePortfolio` → `/api/portfolio/tokens` (`ALCHEMY_API_KEY`, HTTP enhanced API); `LimitOrderPanel:950` → CoW HTTP.

## Top 5 (CU: eth_call 26, blockNumber 10, getBalance 19, getLogs 75; 30 d)
1. Burst traffic, ~260K/day (owner) → ~200M CU/mo if daily; source unproven (rows 5/6 or scraped key).
2. Quotes (6): 6.7M–26.5M CU/mo per tab; one IP at the cap 34M–202M.
3. Chainlink poll (2): 2.2M–13.5M/tab (immutable `decimals`/`description` re-polled).
4. Balances (4): 3.9M–5.8M/tab.
5. Footer (1): 2.2M/tab, no wallet needed.
No-subscriber polling: tick `getBalance` while keepers idle (~1.7M CU/mo), Chainlink immutable reads, Footer for non-connected visitors, `usePortfolio` timers on hidden tabs.

## Recommend (no edits made; savings modelled)
1. Separate Alchemy keys: `/api/rpc`, server adapters+tick, each keeper (env swap, 0 CU, enables attribution).
2. Count provider hostname hits in the deployed JS (count only); if present, keep paid URL server-only (`wagmiConfig.ts:26,131,134`, `rpc.ts:18`, `registry.ts:42,84,132`, `env-validation.ts:21`): up to all burst volume.
3. Weight `/api/rpc` limit by batch size (`route.ts:75`, `kv-rate-limiter.ts:36`): 7,500 → ~300 calls/min/IP.
4. Footer 12 s → 60 s or skip without wallet (`Footer.tsx:13`): −80% row 1 (1.7M CU/mo/tab).
5. `useChainlinkPrice.ts:204-209`: poll only `latestRoundData`: −0–67% row 2.
6. Tick keeper `getBalance` every 5th tick (`monitoring-loop.ts:208-215`): ~1.3M CU/mo.
7. Fee tier in KV (`adapters/shared.ts:136`, `uniswapv3.ts:247`) + amount bucketing/TTL ≥ refresh (`meta-quote-cache.ts:35`): up to −75% cold quote calls.
8. `document.hidden` guard on `usePortfolio.ts:193,416`; keepers already back off — get Base order count before touching `executor.js:1132,1205`.

Unverified: key→env mapping, Base order count, `v1/quote` auth, quote-cache key, multicall alignment, Oct 24–25 cause.
