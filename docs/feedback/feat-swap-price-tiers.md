# feat/swap-price-tiers — FEEDBACK

Goal: replace the client-only "value cannot be verified" block (Chainlink/stable/WETH mirror) with server-authoritative price tiers (owner D1–D4, 26 Oct).
Recon: `~/TeraSwap-Workspace/queue/swap-value-gate-2026-10-26.md`. 3 signed commits: C1 `a39ba3f` quorum · C2 `c9bbf40` server · C3 = this commit (client).
- [x] C1 facts + `src/lib/price-quorum.ts` + pins · [x] C2 `GET /api/swap-price-tier` + `/api/swap` 409 · [x] C3 client tiers + consent · [x] verify + push

## 1. Facts
(a) Client `swap-usd-estimate.ts:33-44` `sideUsd`: `isUsdStablecoin → amount`; `chainlinkPrice != null → amount*price`; `isNativeETH||'WETH' → amount*2000`; else `null`;
`:62` `if (inUsd == null && outUsd == null) return { usd: 0, priced: false }` → `SwapBox:633` `valueUnverifiable` → blocked at ANY size. Server `swap/route.ts:311-325`:
`if (!valuePriced)` (no DefiLlama AND no Chainlink on either leg, `:288-305`) → 422 `"…(DefiLlama or Chainlink)…"`. The UI mirror was STRICTER than the binding gate.
(b) `price-sources.js:152` `BATCH_SIZE = 50`; `:345-348` `contract_addresses=${chunk.join(",")}` — YES it batches. Keyless CoinGecko rejects >1 address (HTTP 400
`10012`, measured today) → `getJson` null → **keeper CoinGecko leg failing silently** when ≥2 DCA tokens are registered and `COINGECKO_API_KEY` is unset (non-Chainlink
legs degrade to `single`: half band + $250 cap/delay). Separate keeper goal — NOT changed (READ-ONLY).

## 2. Shared quorum — `src/lib/price-quorum.ts` (+ `swap-price-tier.ts`, pure vocabulary)
Extracted verbatim from `order-engine/dca-price-quorum.ts` (now a re-export shim, superseded in place — rule #4; `dca-floor-tier.ts` + 3 suites mocking the legacy
path untouched). `quorumPriceUsd` unchanged. New `classifyQuotes` (D4: ≥2 within 300 bps → `priced` {usd=lower, agreementBps=widest}; 1 → `single-source`; 0/disagree →
`unpriced`; trust order chainlink›defillama›coingecko seeds the set — ADR-024 rows 2/3) and `classifyLegPrice(addr, slug, {chainlink})` (injected read; Chainlink under the
SAME 600 s gate). CoinGecko: one address per request (asserted). Pins moved to `price-quorum.test.ts` (frozen 300/600/300/5000 + regex/value vs keeper): RED → GREEN.

## 3. `GET /api/swap-price-tier` — live samples (GET only, 16:15 UTC; no RPC env → Chainlink = resolveFeed null here)
Rate-limited as /api/quote, 400 bad chain/token, 30 s cache per lowercased pair + `Cache-Control: public, max-age=30`, exception → 200 `unpriced` (uncached), native → WETH.
- AERO/ETHFI Base → **priced** (in `defillama+coingecko` usd 0.68196, 1.6 bps; out usd 0.63990, 1.9 bps; pair 1.94 bps). BSWAP/FOMO Base → **unpriced** (0 sources; also
  GALAXIS, MVTT10F, QUAI, SEXY, UOMI, WGC). AJNA/AKUMA Base → **single-source** (DefiLlama only).
- Edge: the quorum counts a DefiLlama row regardless of `confidence` (keeper parity, as DCA), while `/api/swap`'s `fetchDefiLlamaPrice` rejects <0.5 → a low-confidence
  DefiLlama-only pair can be `single-source` here yet 409 on `/api/swap` → the dialog reopens (designed path). Not harmonised — Auditor.

## 4. `/api/swap` — consent instead of 422 (3 RED→GREEN + 4 guard pins)
`!valuePriced` (existing check kept) and `unpricedAck !== true` → 409 `{code:'unpriced_ack_required', requiredTier:'unpriced', unpriceable:true}`: NO `priceGuard`, NO calldata,
`validateSwapPrice` not reached. With `unpricedAck:true` → 200 + calldata, deviation guard still runs (estimate 0 → fail-open <$10k as before); SC-04 and R1 still 400 WITH the
ack; a priced pair ignores the ack (15 000 reaches the guard); one DefiLlama leg → 200, no ack (D2). Ack must be boolean `true`.

## 5. Client tier matrix (SwapBox 8 · QuoteBreakdown 6 · dialog 6 · hook 5 · useSwap 4 · estimate 5, all RED→GREEN)
| tier (`useSwapPriceTier`; null = unknown) | SwapBox | QuoteBreakdown |
|---|---|---|
| unknown | nothing — exotic no-Chainlink pair NOT blocked at $5 (`valueUnverifiable` removed `:633-636`, red copy `:988-1000`) | none |
| priced | nothing; `execute(src, fallbacks)`; leg `usd` → `estimateSwapUsd` (`referencePriceIn/Out`: after Chainlink, before ETH $2k) | none |
| single-source | allowed; limits use that price: 20 000×$1 → `>$10k` red/`oracle` block; 100 → free | `Price from one source only (DefiLlama). Value-based limits use that price; double-check the rate before swapping.` |
| unpriced | Swap → dialog (no execute); tick `I understand — continue` → `execute(…, {unpricedAck:true})`; Cancel → nothing | `No reference price for this pair.` + sentence 1 + "You'll be asked to confirm before swapping." (derived) |
| 409 (`useSwap.unpricedAckRequired`) | dialog opens even if client thought `priced` (D1); hook `idle`, no banner, no 9O walk; Cancel → `reset()` | — |
Dialog = `SwapUnpricedConsentDialog` (DCA structure). REAL placeholders: {N}=`meta.all`, {d}=(max−min)/min (1000/996/1004 → `0.8%`), {minOut}=`deriveMinimumOutput(best, slippage)`
(FeeCollector formula; `997.0000 XOUT` @0.3 %). Deviation: N=1 → `1 source quoted (no second quote to compare against)` (verbatim copy false at N=1). Stale amber
`QuoteBreakdown:211-216` removed; `oracleReadFailed` notice kept. Split swaps post WITHOUT the ack (`useSplitSwap` out of scope) → 409 shows as the split error (fail closed) — follow-up.

## 6. Verify
Suite 329 files / 5123 pass, exit 0 (first final run 5122/5123: my `toFixed` tripped `format.guard` → `fmtPct`, fixed) vs origin/main `ccdf21a` 323 files / 5045 pass. Lint 93 = 93 (Δ0). tsc clean. `check:circular` 0 new. `git diff --stat origin/main`: 24 files, +2177/−423
(no keeper / constants / SC-04 / R1 / min-output / deps / secrets). Extra reads (needed to wire the ack): `useSwap.ts`, `useSplitSwap.ts:111` (grep), `dca-floor-tier.ts`,
`defillama.ts validateSwapPrice`, `minimum-output.ts`, `chains/registry.ts`, test harnesses. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/swap-price-tiers — origin/main advanced past the base `ccdf21a` (imported-tokens PR) during the run; branch NOT rebased (no overlapping files).
