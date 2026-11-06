# feat/retire-force-mev — retire Force MEV, CoW stays an ordinary source (base origin/main 0e0334b, 2026-11-06)

- [x] C0 premise check  - [ ] C1 toggle out, source stays  - [ ] C2 claims + copy  - [ ] C3 monitor sees CoW  - [ ] verify + push

## 1 · Commit-0 finding — PREMISE HOLDS (toggle only biases selection toward CoW)
- Toggle state `mevProtected` (v1 `SwapBox.tsx:79`, v2 `SwapCard.tsx:105`) is read ONLY by `selectBestWithMevPreference`
  (`src/lib/mev-preference.ts:41`): strict filter to `AGGREGATOR_META[*].mevProtected` sources = `cowswap` (the other flagged
  entry, `teraswap_order_engine`, never appears in a swap quote). It is not passed to `useSwap`, slippage, signing or any RPC.
- No private-RPC / Flashbots send path in `src/` (only wallet-RPC advice copy in Docs/Legal). Nothing protects independently of CoW.
- Smart path 2 (CoW promoted within `MEV_PREFERENCE_THRESHOLD` 15 bps when `gasless.recommended`) is a ranking rule -> kept unchanged.
- Not in the goal text: the "Use Gasless Route" CTA (v1 `QuoteBreakdown.tsx:281`, v2 `SwapCard.tsx:608` -> `QuotePanel`) and v1's
  ENABLE strip both call `setMevProtected(true)` — the same hidden CoW-only filter. Asked owner (see Owner answers).
