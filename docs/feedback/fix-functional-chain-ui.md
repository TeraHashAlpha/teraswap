# Feedback — fix/functional-chain-ui (base origin/main 96005c4)

Display/plumbing only. Rows: `site-claims-bugs-2026-10-12.md` F1–F4, C8; C9 from the goal. Ran as Opus 5.5 (goal asked Sonnet).
- [x] C1 F1 `11b0ee8` · [x] C2 F2/F3 `b8b0074` · [x] C3 F4 `019816a` · [x] C4 C8 `9e13b52` · [x] C5 C9 (last commit) · [x] verify + push

## Owner answers (2026-10-23, supersede the goal text)
- F1: Footer had no explorer/chain name/contract → add `<Chain> · Block #N` linked to `<explorer>/block/N`.
- F3: `fmtGas` already at QuoteBreakdown:482 (#586) → USD first + the two cases only.
- C9: "Absolute protection"/"MEV-free" already gone (#587) → change only "to find the best swap rate".
- C8: drop the DefiLlama mention from `PRIVACY_DIRECT_NOTE`.

Outside-list reads/edits (recorded): `lib/chains/*`, `lib/format.ts`, `layout.meta.test.ts`; for C8 `security-headers.test.ts` +
`dca-floor-tier.test.ts` (pinned llama in CSP → inverted), 10 `DCAPanel.*.test.tsx` (+1 parallel `@/lib/defillama-client`
mock, same mock fn), `TokenLogo.test.tsx`, `api/{token-logo,portfolio/prices}`, `lib/api.ts`/`quote-quorum.ts`/`useSplitRoute.ts`
(quorum's DefiLlama call runs only server-side: `useQuote`/`useSplitRoute` go through `/api/quote`).

## Evidence
1. F1 `Footer.test.tsx`: selector 8453, no wallet → `useBlockNumber` mock called with `chainId: 8453`, href
   `https://basescan.org/block/12345678`; set 42161 → `chainId: 42161`, `arbiscan.io`; wallet 42161 beats selector; none → 1/etherscan. 4/4 red on old Footer.
2. F2 recorded fixture `__fixtures__/kyberswap-routes-mainnet.ts` (WETH→USDC, 2026-10-23). Hop `{pool, tokenIn, tokenOut, swapAmount,
   amountOut, exchange, poolType, extra, poolExtra}`; label = `exchange` → `poolType` → 'KyberSwap', refusing embedded 0x.
   Before `0xe0554a476a092703abdb3ef35c80e0d76d32939f` → after `uniswapv3` (fetchQuote + fetchSwapData). UI guard → `sourceLabel`.
3. F3 gas row: `<$0.01 (~0.0000012 ETH)`, `$9.30 (~0.0031 ETH)`, no USD → `~0.0031 ETH`.
   F4 DISPLAY VOLUME (server ranks + cuts top 10 by volume). 5-day fixture: pairs `$5.0K, $3.0K, $170.00` (trades 1/2/5 → tooltip);
   dailyVolume `20 Jun…24 Jun` ascending, also for reversed input (2/2 red on old route).
4. C8 CSP: img-src `- https://raw.githubusercontent.com`, connect-src `- https://coins.llama.fi`. Client-code grep = **0**, next.config.js = 0
   (`no-browser-third-party.test.ts`). Proxies 400 non-address / non-registry chainId before fetching; logo = fixed Trust Wallet
   path, raster only, ≤512 KB, 24 h; price = same `fetchDefiLlamaPrice`, 30 s, 30/min/IP.
5. C9 meta before: "…that queries 8 liquidity sources to find the best swap rate — with…"; after: "…that compares quotes across
   8 liquidity sources — with…" (N = `INTEGRATED_DEX_SOURCE_COUNT`; "MEV-protected routing via CoW Protocol" kept).
6. Suite 310 files / 4797 pass (main 304 / 4726); lint 93 → 93 warnings; tsc clean. `git diff --stat origin/main` excl. this file:
   38 files, +1138 −64 (12 source, 26 tests/fixtures). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/functional-chain-ui

### Concerns (not fixed — out of scope)
- `/api/token-logo` 302s to CoinGecko/DefiLlama CDNs, so the browser still contacts them ("Token logos" kept in the privacy note).
- `/api/proxy/logo` has no rate limit (mirrors `/api/token-logo`); edge cache absorbs repeats.
- `lib/help-content.ts:17` hard-codes "searches 10 liquidity sources … best swap rate on Ethereum" (stale count + same claim).
- Kyber label shows only the first split path (pre-existing `route[0]`); Arbitrum logos now use Trust Wallet `arbitrum` (was `ethereum`).

## Follow-up (commits 6–8, 2026-10-23, Sonnet 5.5)
- [x] C6 CodeQL ReDoS on the grep test · [ ] C7 rate limit · [ ] C8 token-logo stream + help-content · [ ] verify + push
Premises that were stale (owner may override): `/api/price/defillama` ALREADY had a 30/min/IP limit + 429 test (`route.ts:24,37`);
CodeQL queries live at `Performance/ReDoS.ql` + `Performance/PolynomialReDoS.ql` (pack 2.4.8), not `Security/CWE-1333/`.
Outside-list reads (recorded): `src/lib/trusted-ip.ts`, `src/lib/kv-rate-limiter.ts` (the helper), `src/app/api/quote/route.ts:104-118`.

1. **ReDoS.** Old `/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*['"]use client['"]/` → new `hasUseClientDirective()`, a linear
   scan (skip `\s`, `//`→EOL via `indexOf`, `/*`→`*/` via `indexOf`, then `startsWith`). Same result on all 313 non-test src files
   (91 `'use client'`, 0 disagreements); 14 tests incl. `'//'.repeat(50_000)` < 2 s.
   Local CodeQL (`scripts/codeql-local.sh`, same DB for both): before ReDoS **2** (`no-browser-third-party.test.ts:40` ×2),
   PolynomialReDoS 0 → after ReDoS **0**, PolynomialReDoS **0**. No dismissals.
