# Feedback — chore/copy-leftovers

Display/copy/plumbing only. No tier, gate, quote or pricing logic; nothing under `src/ui/v2`.

- [x] C1 one price notice, from the tier
- [x] C2 source counts that mean something
- [x] C3 help-content leftovers
- [x] C4 token-logo rate limit + CSP + Velora labels
- [x] C5 flaky `usePortfolio` test
- [ ] Verify + evidence 1–6

## Premise check
- The blue "No oracle available…" notice was in `SwapBox.tsx` (else-branch of the `oracleUnavailable` block), not
  `QuoteBreakdown.tsx`; QuoteBreakdown only holds the tier notices. Same notice, wrong file in the goal — proceeded.

## 1. Notice matrix (pair with no Chainlink feed, 5 units; real SwapBox + real QuoteBreakdown)
| tier | before | after |
|---|---|---|
| priced | blue | none |
| single-source | blue + amber | amber |
| unpriced | blue + "No reference price" | "No reference price" |
| unknown (null) | blue | none |
Before = the new matrix test run against unfixed SwapBox: 4/4 failed with `legacyBlue: true`. The USD-gate notices
(amber "high value swap", red "Swap blocked") are separate and untouched. Static guard:
`no-legacy-oracle-notice.test.ts` (no such string under `src/components`).

## 2. Source-count strings
- Toggle: `8/8 sources` → `8 sources enabled` (none excluded) / `7 of 8 sources enabled` (partial); count = `TOGGLEABLE_SOURCES.length`,
  asserted equal to `INTEGRATED_DEX_SOURCE_COUNT`. Quote card unchanged: `N sources queried` (= `meta.all.length`, i.e.
  responders; "queried" is loose wording but kept as asked). Tests: SourceToggle.test.tsx (both toggle forms, no `x/y`),
  SwapBox.price-tiers.test.tsx (`3 sources queried`).

## 3. help-content (goal said :29/:38; actual :32/:41)
- `supports Ethereum Mainnet.` → `supports ${SWAP_CHAIN_LIST_LABEL}.` (live: Ethereum Mainnet, Base, and Arbitrum One).
- `queries 10 sources (1inch, 0x, KyberSwap, CowSwap, Uniswap V3, OpenOcean, SushiSwap, Balancer, Curve, and Velora)` →
  `queries ${INTEGRATED_DEX_SOURCE_COUNT} sources (${formatChainList(INTEGRATED_DEX_SOURCE_LABELS)})` = 8 live labels.
- Found by the new "no disabled source name anywhere in help text" test: the audit answer also said `(Uniswap, Balancer, Curve, etc.)`
  → `(Uniswap, Curve, etc.)`. Left alone (not asked): the privacy answer still says IP is "never exposed" — product-claims says that is NOT claimed.

## 4. token-logo / CSP / Velora
- Limit: `token-logo:<trustedClientIp>` 300/min, 429 + `Cache-Control: no-store`, local const (kv-rate-limiter.ts was read-only).
  Why 300: catalogs hold 987 / 311 / 296 tokens (ETH / Base / Arb) → one Base/Arb full-list render ≈ 300 logos; = `RPC_RATE_LIMIT`;
  only cache misses reach the function. Test: 300 pass, 301st → 429 no-store, no upstream fetch, per-IP, own key (32 route tests pass).
- CSP `img-src`: `… https://tokens.1inch.io https://assets.coingecko.com` → `… https://tokens.1inch.io`. Grep (src, public):
  `assets.coingecko.com` appears only in `token-logo/route.ts` + `logo-proxy.ts` (server fetch/allow-list), 0 client loads, 0 in the
  generated catalogs. 1inch kept: `usePortfolio.ts:75`, `tokens.ts:819`. Test in security-headers.test.ts.
  Left: `images.remotePatterns` (next.config.js:9) still lists coingecko — outside the "CSP img-src only" read scope.
- Velora: recorded `GET api.paraswap.io/prices` (10 WETH→USDC, 2026-10-26; one public read-only call) →
  `__fixtures__/velora-prices-mainnet.ts`; hops were `metric-v1, metric-v1, uniswapv4`, now `Velora, Uniswap V4` (known-venue map, else
  "Velora", deduped). The response names no DEX for `metric-v1`, so "where the response gives one" = only the map.

## 5. Flaky `usePortfolio` (Base Alchemy-503)
- Cause (read hook, extra read): first render is on the Alchemy path and `useBalance` gives native ETH, so `tokens` is non-empty
  BEFORE the 503 flips to the multicall fallback; `waitFor(tokens.length > 0)` matched that ETH-only state, then USDC raced the fetch
  continuation. Fix: 503 held behind a deferred; assert `['ETH']` first (the old wait condition), release, `waitFor` USDC (5 s cap).
- 20× whole-file: idle 20/20 green; under 20 CPU burners 20/20 green. NOT reproduced before the fix either (0/40 red), so the 20×
  is consistency, the `['ETH']`-before-release assertion is the deterministic proof.
