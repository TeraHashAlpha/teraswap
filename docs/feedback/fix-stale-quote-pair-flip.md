# Feedback — fix/stale-quote-pair-flip (recon 58)

Goal: quote carries identity; stale quotes never render; guard two-sided; flip request + Base USDC badge.
No PR (owner opens). No change to useSwap, /api/swap, calldata, minimumOutput derivation, QUOTE_RATE_LIMIT, poll interval, copy.

## Checklist
- [x] C1 useQuote tags `meta` with identity; setMeta only on key match + !aborted; clear on flip/token/chain change; SwapBox uses quote's decimalsOut; gates read key-matching quote only
- [x] C2 /api/quote echoes tokenIn/tokenOut/chainId/decimalsIn/decimalsOut/amountIn; client keys from echo
- [x] C3 assertSwapConsistentWithQuote two-sided + pair/chain mismatch refusal
- [x] C4 flip skips immediate refetch while debounce pending; TokenAddressBadge uses useQuoteChainId
- [ ] Verify: suite vs origin/main (312 files / 4880 tests, lint 93 warn), tsc, diff --stat, push, compare link

## Baseline (origin/main 3a97f76)
312 files / 4880 tests pass; eslint 93 warnings, 0 errors.

## Scope record
Reads outside the list: `src/lib/adapters/types.ts` (MetaQuoteResult shape, ~15 lines); grep-only for call sites of
`useQuote`, `assertSwapConsistentWithQuote`, `selectBestWithMevPreference`/`scopeToExecutable` locations.
Out-of-list EDIT (forced): `src/components/DigitRoller.test.tsx` — its SwapBox fixture mocks `useQuote` with a quote that has no
identity; fail-closed SwapBox now (correctly) shows no quote, so one fixture line (identity) was added. No assertion changed.

## Findings (C3 — Auditor-note: quote→swap guard, tightening only)
- Ceiling = basis·(10000+slipBps+SWAP_QUOTE_TOLERANCE_BPS)/10000 (constant unchanged; fee-netted basis; uniswapv3 still skip-listed).
  Liveness trade-off: a >1% FAVOURABLE move between quote and /swap build (at 0.5% slippage) now refuses ("review and try again").
- `quotePair`/`swapPair` (mismatch refusal; one-without-the-other refuses) are optional params and NOT wired at the call sites —
  useSwap/useSplitSwap are on the Do-NOT list. Inert in prod until a follow-up wires them. The stale-pair case is already refused
  end-to-end: SwapBox passes `{}` as quoteToAmountBySource for a non-matching quote → existing fail-closed "No accepted quote".
- 3 out-of-list useSplitSwap.test fixtures changed (they overshot a leg by +33%/+80%/+90%, impossible under a two-sided guard);
  intent kept (fresh≠stale minOut; uniswapv3 leg unfloored; per-leg floor independent of aggregate), numbers now inside the window.
