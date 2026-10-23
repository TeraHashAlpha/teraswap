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
- [x] C6 CodeQL ReDoS on the grep test · [x] C7 rate limit · [x] C8 token-logo stream + help-content · [x] verify + push
Premises that were stale (owner may override): `/api/price/defillama` ALREADY had a 30/min/IP limit + 429 test (`route.ts:24,37`);
CodeQL queries live at `Performance/ReDoS.ql` + `Performance/PolynomialReDoS.ql` (pack 2.4.8), not `Security/CWE-1333/`.
Outside-list reads (recorded): `src/lib/trusted-ip.ts`, `src/lib/kv-rate-limiter.ts` (the helper), `src/app/api/quote/route.ts:104-118`.

1. **ReDoS.** Old `/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*['"]use client['"]/` → new `hasUseClientDirective()`, a linear
   scan (skip `\s`, `//`→EOL via `indexOf`, `/*`→`*/` via `indexOf`, then `startsWith`). Same result on all 313 non-test src files
   (91 `'use client'`, 0 disagreements); 14 tests incl. `'//'.repeat(50_000)` < 2 s.
   Local CodeQL (`scripts/codeql-local.sh`, same DB for both): before ReDoS **2** (`no-browser-third-party.test.ts:40` ×2),
   PolynomialReDoS 0 → after ReDoS **0**, PolynomialReDoS **0**. No dismissals.
2. **Rate limit.** Reused `checkRateLimit` (`src/lib/kv-rate-limiter.ts:155`) + `QUOTE_RATE_LIMIT` 30/min (`:28`) + `trustedClientIp`
   (`src/lib/trusted-ip.ts`), copied from `GET /api/quote` (`src/app/api/quote/route.ts:104-118`; 429 + `X-RateLimit-Remaining/Reset`).
   `/api/proxy/logo` new: key `logo:<ip>`, 429 is `no-store` (never CDN-pinned); validation after the check, edge hits never reach it.
   `/api/price/defillama` already limited — only moved off its left-most `x-forwarded-for` read (client-writable → limit bypass) onto
   `trustedClientIp` + the shared constant (same 30/min). Tests: logo 30 pass → 31st 429 (fetch not called, headers, per-IP buckets,
   spoofed XFF ignored, 200 path keeps 24 h `public` cache); defillama same + N+1. 6 red on old routes, 46/46 green.
3. **token-logo** (real network, `next dev`). DAI before: `302` · `location: https://assets.coingecko.com/coins/images/9956/large/Badge_Dai.png?…`
   · `cache-control: public, s-maxage=86400, swr=604800`; no-logo addr before: `302` → `https://token-icons.llamao.fi/icons/tokens/1/0x…dead?h=48&w=48`.
   After: DAI `200` · `content-type: image/png` · 7297 B · `cache-control: public, max-age=86400, s-maxage=86400, swr=604800` · `nosniff` · **no
   Location**; no-logo `404` · `s-maxage=3600` · 0 B (→ `<TokenLogo>` next candidate). Shared `src/lib/logo-proxy.ts` (host allow-list, raster only,
   ≤512 KB read incrementally, 5 s, redirects by hand ≤2 hops each re-checked); /api/proxy/logo now uses it too. A CoinGecko-list `logoURI` off the
   allow-list (http, look-alike, creds, port, 169.254…) is never fetched → DefiLlama. `tokens.ts` PAXG/XAUt hard-coded CoinGecko URLs → `logo()` route
   (both serve 200 PNG via route). Grep test now 6 hosts, client = 0, + token-logo has no redirect/30x/Location; 3 red on old code.
4. **help-content.ts:17** before: "…searches 10 liquidity sources simultaneously to find you the best swap rate on Ethereum." → after: "…compares quotes
   across 8 liquidity sources simultaneously on Ethereum, Base, and Arbitrum One." (`INTEGRATED_DEX_SOURCE_COUNT`, `SWAP_CHAIN_LIST_LABEL`).
   `help-content.test.ts` (new): no `\b10\b`, no "best swap rate", and a mocked product-claims (3 / "Chain A and Chain B") changes the sentence.
5. **Verify.** Suite 312 files / 4864 pass vs origin/main `697970a` 304 / 4730; lint 93 → 93 warnings (0 errors); tsc clean both. New commits only
   (`9074a88..HEAD`, excl. this file): 13 files, +754 −180 (7 source, 6 tests; commits `ea95261` `db1d9c7` `65932e8` `2ed7133`, all SSH-signed). Local CodeQL on the
   final tree: ReDoS 0, PolynomialReDoS 0, full `javascript-code-scanning.qls` 6 (all pre-existing, none in a touched file, no request-forgery on logo-proxy).
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/functional-chain-ui (PR #591 exists; none opened). CI not polled (goal).

### Concerns (not fixed — out of scope; the three C8 ones above are now resolved)
- `/api/token-logo` is unrated and now streams bytes; edge cache absorbs repeats, but 30/min would break the token list → needs a higher dedicated limit.
- CSP `img-src` still lists `https://assets.coingecko.com` (and 1inch); no repo code needs the first any more → candidate to drop (not done: CSP out of scope).
- Next adds its global CSP header over the route's own `default-src 'none'; sandbox` on logo responses (seen via `next dev`; raster-only + `nosniff` hold).
- `help-content.ts:29` "supports Ethereum Mainnet" and `:38` "queries 10 sources (… OpenOcean, Balancer …)" are the same stale claims; untouched (goal = line 17).
- Dead-source icons are now a cached 404 (was a 302 to a 404): `<TokenLogo>` falls to Trust Wallet, then the avatar — same end state.
