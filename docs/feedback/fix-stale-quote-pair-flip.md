# Feedback — fix/stale-quote-pair-flip (recon 58) — DONE, no PR (owner opens)

Commits: C1 `b98c542` · C2 `6dfe856` · C3 `65d8372` · C4 `e0327e3` (all SSH-signed). Untouched: useSwap, /api/swap, calldata, minimumOutput derivation, QUOTE_RATE_LIMIT, poll interval, copy.

1. **Key/abort logic** (`useQuote.ts`): `meta` = `{…quote, identity{chainId,tokenIn,tokenOut,amountRaw,decimalsIn,decimalsOut,fetchedAt}}`.
   Store only if `parseQuoteEcho(res)` ok ∧ `!signal.aborted` ∧ `sameQuoteKey(echo, currentKeyRef)`; stored quote dropped on pair change
   (reset-in-render); exposed `meta` also filtered by `sameQuotePair` so the flip render never shows the old quote. SwapBox: one
   `matchedRawMeta` choke point (display, oracle gates :248-267/:599-612, `quoteToAmountBySource`) + `quoteDecimalsOut` from the quote.
   Tests: flip→meta null in the next render; flip-back doesn't resurrect; late old-pair + superseded-amount responses ignored (fail
   when the check is removed); same-pair re-quote rendered; SwapBox flip → no RECEIVE/breakdown, gates `execIn` null, `useSwap` gets `{}`.
2. **Response shape** — before: `{best, all, fetchedAt, crossQuote*, lowConfidence?}`. After (GET and POST, per-response copy, cache untouched):
   same + `tokenIn, tokenOut, chainId (default 1), decimalsIn, decimalsOut, amountIn` — keys pinned in `route.test.ts`. No echo → client error, no quote.
3. **Guard** (`minimum-output.ts`): ceiling `basis·(10000+slipBps+50)/10000` beside the floor; tolerance constant unchanged; uniswapv3 still skipped.
   Tests (75): at/±1 wei both sides at 0%/5%/fee-routed (1_003_995), ⇅ shapes both directions, copy, aggregate (`null`) bounded, 4 mismatch kinds,
   lone key refuses, skip list doesn't exempt a mismatch.
4. **Requests per flip+type** (⇅ with amount cleared, then type 5): **before 2** (immediate refetch `amount=1000000` = old amount under new
   decimals, then `5000000`), **after 1** (`5000000`). Same scenario run on origin/main vs branch, real debounce + fake timers.
5. **Badge**: `TokenAddressBadge.base-chain.test.tsx` (real hooks + catalog, wagmi disconnected, Base picked): Base USDC → green ✓, no ⚠; failed before the fix.
6. **Verify**: origin/main 312 files/4880 tests, lint 93 → branch **314 files/4938 tests pass**, lint **93 (Δ0)**, `tsc` clean. 16 files, +1005/−53 (`git diff --stat origin/main..HEAD`).
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/stale-quote-pair-flip

## For the Auditor / follow-ups
- **Guard liveness:** a >1% *favourable* move between quote and /swap build (0.5% slippage) now refuses ("review and try again"); was silent.
- **Mismatch refusal is inert in prod:** `quotePair`/`swapPair` aren't passed by useSwap/useSplitSwap (Do-NOT list) — wire in a follow-up. The stale-pair case is
  already refused today via SwapBox's `{}` quote map → existing "No accepted quote".
- **Deploy skew:** new client + old server (no echo) → quotes fail closed with "Failed to fetch quotes"; ship together.
- **Out-of-list reads (all read-only, none edited unless stated):** `adapters/types.ts` (MetaQuoteResult); `hooks/useSwap.ts` ~536-552 (guard call site) and ~726-750
  (StaleOrTamperedSwapError handling); `hooks/useSplitSwap.ts` ~440-465 (same); `hooks/useSplitSwap.test.ts` ~760-1060 (fixtures); `components/DigitRoller.test.tsx` ~268-292;
  grep-only: `useQuote`/`assertSwapConsistentWithQuote` call sites, `selectBestWithMevPreference`/`scopeToExecutable`, `deviationPercent` consumers.
  **Edited (forced by fail-closed):** `DigitRoller.test.tsx` (identity line) and 3 fixtures in `useSplitSwap.test.ts` (legs overshot +33/+80/+90%; now inside the window, same intent).
- Not done: `QuoteBreakdown` still formats with `tokenOut.decimals` (receives only matched quotes now); recon 58's unexplained 64 s delay and the tester's exact figure remain unreproduced.
