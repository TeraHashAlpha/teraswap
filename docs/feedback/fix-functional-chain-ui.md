# Feedback — fix/functional-chain-ui (base origin/main 96005c4)

Display/plumbing only. Source rows: `site-claims-bugs-2026-10-12.md` F1–F4, C8; C9 from the goal.

## Checklist
- [x] C1 F1 footer follows the selected chain
- [x] C2 F2 KyberSwap route names · F3 gas USD-first
- [x] C3 F4 Analytics pairs metric + volume trend order
- [x] C4 C8 logo + DefiLlama proxies, CSP hosts removed
- [ ] C5 C9 meta description
- [ ] Verify: suite vs main, lint delta 0, tsc, diff --stat, push

## Owner answers (2026-10-23, supersede the goal text)
- F1: Footer had no explorer/chain name/contract → add `<Chain> · Block #N` linked to `<explorer>/block/N`.
- F3: `fmtGas` already at QuoteBreakdown:482 (#586) → USD first + the two test cases only.
- C9: "Absolute protection"/"MEV-free" already gone (#587) → change only "to find the best swap rate".
- C8: drop the DefiLlama mention from `PRIVACY_DIRECT_NOTE` (logos stay: catalog logoURI / CoinGecko 302).

Reads/edits outside the list (recorded): `lib/chains/*` (explorer/name), `lib/format.ts`; C8 consequences —
`security-headers.test.ts` + `dca-floor-tier.test.ts` (pinned llama in CSP → inverted), 10 `DCAPanel.*.test.tsx`
(+1 parallel `@/lib/defillama-client` mock each, same mock fn), `TokenLogo.test.tsx`, `api/{token-logo,portfolio/prices}`
(conventions), `lib/api.ts`/`quote-quorum.ts`/`useSplitRoute.ts` (proved quorum's DefiLlama call is server-only).

## Evidence
1. F1 — `Footer.test.tsx` "Footer follows the selected chain": selector 8453/no wallet → `useBlockNumber` mock
   last called with `chainId: 8453`, link `https://basescan.org/block/12345678`; set 42161 → `chainId: 42161`,
   `https://arbiscan.io/…`; wallet 42161 beats selector 8453; nothing selected → 1/etherscan. 4/4 red on old Footer.
2. F2 — fixture recorded 2026-10-23 (`__fixtures__/kyberswap-routes-mainnet.ts`, WETH→USDC mainnet). Hop shape:
   `{pool, tokenIn, tokenOut, swapAmount, amountOut, exchange, poolType, extra, poolExtra}`. Label = `exchange`
   → `poolType` → 'KyberSwap', refusing any embedded 0x address. Before `0xe0554a476a092703abdb3ef35c80e0d76d32939f`
   → after `uniswapv3`. Applied to fetchQuote AND fetchSwapData (both mapped `r.pool`). QuoteBreakdown guard
   falls back to `sourceLabel(source)` (= 'KyberSwap' for Kyber; correct name if another source ever emits an address).
3. F3 — "Est. gas" row: 0.0000012/$0.0036 → `<$0.01 (~0.0000012 ETH)`; 0.0031/$9.30 → `$9.30 (~0.0031 ETH)`;
   usd 0 → `~0.0031 ETH`.
   F4 — chose DISPLAY VOLUME (server ranks + cuts top 10 by volumeUsd; re-sorting by trades would rank a
   volume-cut list). 5-day fixture (`__fixtures__/analytics-five-days.ts`): pairs `WBTC/USDC $5.0K, WETH/USDC
   $3.0K, WETH/DAI $170.00` (trades 1/2/5 → tooltip); dailyVolume `20 Jun…24 Jun` ascending, also for reversed
   input (2/2 red on old route). Sort key = bucket's earliest timestamp (label "24 Jun" has no year).
4. C8 — CSP diff: img-src `- https://raw.githubusercontent.com`; connect-src `- https://coins.llama.fi`.
   Grep over client code (components, hooks, 'use client', defillama-client) = **0**; next.config.js = 0
   (`no-browser-third-party.test.ts`). Proxies 400 non-address/non-registry chainId before any fetch; logo:
   fixed Trust Wallet path, raster image/* only, ≤512 KB, 24 h; price: same `fetchDefiLlamaPrice`, 30 s, 30/min/IP.

### Concerns (not fixed — out of scope)
- `/api/token-logo` 302s to CoinGecko/DefiLlama CDNs → browser still contacts them (privacy note keeps "Token logos").
- `/api/proxy/logo` has no rate limit (mirrors `/api/token-logo`); edge cache absorbs repeats.
- Kyber label shows only the first split path (pre-existing `route[0]`); Arbitrum logos now use Trust Wallet `arbitrum` (was `ethereum`).
