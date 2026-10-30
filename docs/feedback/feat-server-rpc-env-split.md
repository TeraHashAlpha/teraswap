# Feedback — feat/server-rpc-env-split (strictly additive; Auditor-note: RPC path of gates)

Premise deltas (owner may supersede): `/api/rpc` **already capped batches at 25** (`MAX_RPC_BATCH_SIZE`) — C3 only adds
per-call rate-limit units. No `docs/Runbooks/ENV*.md` existed → created `docs/Runbooks/ENV-RPC.md`.

## 1. Env table
| Name | Used by | Fallback chain (first non-empty wins) | Optional? |
|---|---|---|---|
| `RPC_URL_1` | server | → `RPC_URL` → `NEXT_PUBLIC_RPC_URL` → llamarpc | yes (warn) |
| `RPC_URL_8453` | server | → `NEXT_PUBLIC_BASE_RPC_URL` → registry fallback (mainnet.base.org) | yes (warn) |
| `RPC_URL_42161` | server | → `NEXT_PUBLIC_ARBITRUM_RPC_URL` → registry fallback (arb1.arbitrum.io) | yes (warn) |
| `RPC_URL` (legacy) | server, **mainnet only** | kept; ranked after `RPC_URL_1`; never answers Base/Arb | yes |
| `NEXT_PUBLIC_RPC_URL` / `_BASE_RPC_URL` / `_ARBITRUM_RPC_URL` | browser (+ server fallback) | → public default; browser order unchanged | RPC_URL: required (unchanged) |

## 2. Call-site rewiring (server → `rpc-env`)
`src/lib/rpc.ts:19` (getPrivateClient/getRpcUrl) · `src/lib/adapters/shared.ts:102,121` (getRpcUrl, getRpcUrlForChain → `/api/rpc`
upstream, chainlink, uniswapv3, curve) · `src/lib/chains/clients.ts:57` (non-mainnet clients: swap/quote/sim/monitor/chain-verify)
· `src/lib/on-chain-monitor.ts:350` · `src/lib/api.ts:479,488` (quote diagnostic). Browser modules (`wagmiConfig.ts`,
`registry.ts`) untouched; `registry.rpc.primary` is still read at import but every server consumer overrides it.

## 3. Set/unset proof + guard
`rpc-env.server-paths.test.ts` (8): SET → URL given to `http()`/`guardedHttp()` is `RPC_URL_<id>` per chain and a `process.env`
Proxy records **0** `NEXT_PUBLIC_*RPC*` reads; UNSET → browser env / public default as before. `rpc-env.test.ts` (10): order,
log line `rpc: chain=<id> source=<NAME>` once per chain, value never logged. `rpc-env.guard.test.ts` (3): fails on a new
`process.env.NEXT_PUBLIC_*RPC*` read; allowlist = rpc-env, registry, wagmiConfig. Mutation-checked (breaking clients/shared
or adding a rogue file fails 5 tests).

## 4. /api/rpc batch
`route.rate-units.test.ts` (7): 1 call = 1 unit; 25-call batch = **25 units** in one limiter call, forwarded; 26-call = 400
`-32005`, nothing forwarded; 429 path; empty/unparseable = 1. `checkRateLimit(…, cost=1)`: allowed iff `count+cost<=limit`
(cost 1 = old rule). **Concern:** budget is now calls/min (300), so a batching client has fewer requests/min than before.

## 5. Verification
Suite **387 files / 6179 tests** pass vs origin/main baseline 383 / 6147 (+4 files, +32 tests, 0 changed); lint 93 warnings
= 93 (delta 0); `tsc --noEmit` clean; `next build` OK; #622 budgets green; nothing under `src/ui/`; no new deps.
`git diff --stat origin/main`: 19 files, +696/−28 (incl. this file). Compare:
https://github.com/TeraHashAlpha/teraswap/compare/main...feat/server-rpc-env-split

Owner step: set `RPC_URL_1/8453/42161` in Vercel (un-allowlisted key), redeploy, check `rpc: chain=<id> source=RPC_URL_<id>`
in logs, then enable the browser allowlist. Rollback = unset.
