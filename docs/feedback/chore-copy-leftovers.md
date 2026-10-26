# Feedback — chore/copy-leftovers
Display/copy/plumbing only; no tier/gate/quote/pricing logic; nothing under `src/ui/v2`. C1–C5 done, one signed commit each.

**Premises that differed (proceeded, same substance):** the blue notice lived in `SwapBox.tsx` (else-branch of the `oracleUnavailable`
block), not `QuoteBreakdown.tsx`; help-content lines were :32/:41 not :29/:38; the Base-503 flake did not reproduce (see 5).

## 1. Notice matrix (no-feed pair, real SwapBox + real QuoteBreakdown)
| tier | before | after |
|---|---|---|
| priced / unknown | blue | none |
| single-source | blue + amber | amber |
| unpriced | blue + "No reference price" | "No reference price" |
Before = new matrix test on unfixed code: 4/4 red (`legacyBlue: true`). USD-gate notices (amber/red) untouched. Static guard: no
"No oracle available" / "aggregator quotes only" under `src/components`.

## 2. Counts
Toggle `8/8 sources` → `8 sources enabled` (partial: `7 of 8 sources enabled`; count = `TOGGLEABLE_SOURCES` == `INTEGRATED_DEX_SOURCE_COUNT`).
Quote card keeps `N sources queried` (= `meta.all.length`, responders; wording is loose but kept as asked). Both tested.

## 3. help-content
`supports Ethereum Mainnet.` → `${SWAP_CHAIN_LIST_LABEL}` (Ethereum Mainnet, Base, and Arbitrum One). `queries 10 sources (…OpenOcean…Balancer…)` →
`${COUNT} sources (${labels})` = 8 live. New "no disabled source in help text" test also caught `(Uniswap, Balancer, Curve…)` → fixed.
Not touched: privacy answer says IP is "never exposed" (product-claims says that is not claimed).

## 4. token-logo / CSP / Velora
- Limit `token-logo:<ip>` 300/min, 429 + `no-store`, const local (limiter file read-only). Why: catalogs 987/311/296 tokens (ETH/Base/Arb) → a
  Base/Arb list render ≈ 300 logos; = `RPC_RATE_LIMIT`; only cache misses count. Test: 300 pass, 301st 429, no fetch, per-IP, own key.
- CSP `img-src`: dropped `https://assets.coingecko.com`. Grep: only server code (`token-logo/route.ts`, `logo-proxy.ts` allow-list), 0 client, 0 in catalogs.
  Kept 1inch (`usePortfolio.ts:75`, `tokens.ts:819`). `images.remotePatterns` (next.config.js:9) still lists coingecko — out of read scope.
- Velora: recorded live `/prices` (10 WETH→USDC, 2026-10-26, one public GET) → `__fixtures__/velora-prices-mainnet.ts`. Hops `metric-v1, metric-v1,
  uniswapv4` → `Velora, Uniswap V4`. The response names no DEX for `metric-v1`, so only a known-venue map names; else "Velora"; deduped.

## 5. Flaky `usePortfolio` (Base 503)
First render is ETH-only (Alchemy path + `useBalance`), which already satisfied `waitFor(tokens.length > 0)`; USDC then raced the 503 continuation.
Fix: 503 behind a deferred, assert `['ETH']`, release, `waitFor` USDC. 20× whole file: 20/20 idle, 20/20 under 20 CPU burners. Pre-fix 0/40 red
(not reproduced), so the `['ETH']` assertion is the proof, the 20× only consistency. Extra read: `usePortfolio.ts`.

## 6. Verify
Suite 343 files / 5412 pass vs clean origin/main f32ac28 342 / 5393 (+1 file, +19 tests = mine). Lint 93 warn = main 93 (Δ0). tsc clean.
`git diff --stat`: 16 files, +519/−37. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/copy-leftovers
