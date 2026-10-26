# feat/swap-price-tiers — FEEDBACK

Goal: replace the client-only "value cannot be verified" block (Chainlink/stable/WETH mirror) with server-authoritative
price tiers (D1–D4, owner 26 Oct). Recon: `~/TeraSwap-Workspace/queue/swap-value-gate-2026-10-26.md`.

- [x] C1 facts (a)(b) + shared `src/lib/price-quorum.ts` + pin tests green  - [x] C2 `GET /api/swap-price-tier` + `/api/swap` 409 `unpriced_ack_required`
- [ ] C3 client: drop local block, tier notice, consent dialog, `unpricedAck`  - [ ] verify (suite/lint/tsc/diff --stat), push, compare link

## 1. Facts
(a) Client rule `swap-usd-estimate.ts:33-44` `sideUsd`: `isUsdStablecoin → amount`; `chainlinkPrice != null → amount * chainlinkPrice`;
`isNativeETH || 'WETH' → amount * ETH_FALLBACK_USD`; else `null`. `:62` `if (inUsd == null && outUsd == null) return { usd: 0, priced: false }`
→ `SwapBox.tsx:633` `valueUnverifiable` → blocked at ANY size. Server rule `swap/route.ts:311-325`: `if (!valuePriced)` (no DefiLlama
AND no Chainlink on EITHER leg, `:288-305`) → 422 `"…neither token has price coverage (DefiLlama or Chainlink)…"`, `unpriceable: true`.
The UI mirror (Chainlink-only) is stricter than the binding server gate (DefiLlama OR Chainlink).
(b) `price-sources.js:152` `export const BATCH_SIZE = 50`; `:345-348` `for (const chunk of chunks(addrs, BATCH_SIZE)) { const url =
…/simple/token_price/${platform}?contract_addresses=${chunk.join(",")}&…`. YES it batches. Keyless CoinGecko now rejects >1 address
(HTTP 400 `error_code 10012`, measured 2026-10-26) → `getJson` → null → `continue` → **keeper CoinGecko leg failing silently** whenever
≥2 DCA tokens are registered in a cycle and `COINGECKO_API_KEY` is unset (quorum degrades to Chainlink+DefiLlama; non-Chainlink legs →
`single`: half band + $250 cap / delay). Separate keeper goal — NOT changed here (READ-ONLY).

## 2. Shared quorum — `src/lib/price-quorum.ts` (+ `src/lib/swap-price-tier.ts`, pure vocabulary)
Extracted verbatim from `order-engine/dca-price-quorum.ts` (now a re-export shim, superseded in place — rule #4; `dca-floor-tier.ts`
and the 3 suites that `vi.mock('@/lib/order-engine/dca-price-quorum')` untouched). `quorumPriceUsd` semantics unchanged (DefiLlama+CoinGecko
agree → lower price, else null). New: `classifyQuotes` (D4: ≥2 within 300 bps → `priced` {usd=lower, agreementBps=widest}; 1 → `single-source`;
0/disagree → `unpriced`; trust order chainlink›defillama›coingecko seeds the agreeing set — ADR-024 rows 2/3), `classifyLegPrice(addr, slug,
{chainlink})` (injected read, RPC-free module; Chainlink gated by the SAME 600 s rule — ADR-024 parity; Base USDC's 24 h feed is absent, priced
via the off-chain pair). CoinGecko: one address per request (asserted: no `,` in `contract_addresses`). Pin tests moved to `src/lib/price-quorum.test.ts`
(frozen 300/600/300/5000 + regex/value vs keeper) — RED (module missing) → GREEN 7 files/112 tests incl. dca-floor-tier, dca-floor-cap, orders-floor-consent.
`no-browser-third-party` allow-list: + `src/lib/price-quorum.ts` (server-only).

## 3. `GET /api/swap-price-tier?chainId&tokenIn&tokenOut` — live samples (GET only, 2026-10-26 16:15 UTC, no RPC env → Chainlink leg = resolveFeed null for these)
Rate-limited as /api/quote (`QUOTE_RATE_LIMIT`, trusted IP), 400 on bad chain/token, 30 s cache per lowercased (chainId,in,out) + `Cache-Control: public,
max-age=30, s-maxage=30`, exceptions → 200 `unpriced` (not cached), native ETH → the chain's WETH. Per-leg `tier` is an extra field (the client names the
single source from it). 14 route tests.
- AERO/ETHFI Base → `priced`: in `{defillama,coingecko, usd 0.68196, 1.6 bps}`, out `{…, usd 0.63990, 1.9 bps}`, pair agreementBps 1.94.
- BSWAP/FOMO Base (`0x78a0…3ae9` / `0x9A86…2002`) → `unpriced` (0 sources both legs; also GALAXIS, MVTT10F, QUAI, SEXY, UOMI, WGC).
- AJNA/AKUMA Base → `single-source` (DefiLlama only). Edge: the quorum counts a DefiLlama row regardless of `confidence` (keeper parity, unchanged from
  DCA), while `/api/swap`'s `fetchDefiLlamaPrice` rejects confidence <0.5 — so a low-confidence DefiLlama-only pair can be `single-source` here yet
  `!valuePriced` on `/api/swap` → 409 → the dialog reopens (the goal's "409 reopens the dialog" path). Not harmonised; flag for the Auditor.

## 4. `/api/swap` — consent instead of the 422 (7 tests, 3 RED→GREEN, 4 guard pins)
`!valuePriced` (existing DefiLlama-OR-Chainlink check, unchanged) and `unpricedAck !== true` → 409 `{code:'unpriced_ack_required', requiredTier:'unpriced',
unpriceable:true}` — NO `priceGuard` (the client's hard-block flag), NO calldata, `validateSwapPrice` not reached. With `unpricedAck:true` → 200 + calldata,
`validateSwapPrice` still runs (estimatedValueUsd 0 → DefiLlama fail-open <$10k, as before); SC-04 unknown selector and R1 mismatch still 400 WITH the ack;
a priced pair ignores the ack (estimate 15 000 reaches the guard); one DefiLlama leg → 200 with no ack (D2). Ack must be boolean `true` ('true'/1/{} → 409).
