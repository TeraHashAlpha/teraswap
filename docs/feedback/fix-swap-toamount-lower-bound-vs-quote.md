## Feedback — fix/swap-toamount-lower-bound-vs-quote

### Task checklist
- [x] C1 — `assertSwapConsistentWithQuote` + `StaleOrTamperedSwapError` (minimum-output.ts), wired in
      `useSwap.ts` right before `deriveMinimumOutput`
- [ ] C2 — tests (minimum-output.test.ts pure-function boundary/skip/malformed; useSwap.test.ts
      end-to-end block/pass + AGGREGATOR_META positive control)
- [ ] C3 — UX (surface like PriceGuardError, exclude from 9O fallback) + this file's final evidence

### Why (Architect ruling on #524 Auditor H-01)
`deriveMinimumOutput` derives the FeeCollector on-chain floor from `swapData.toAmount` — the SAME
`/swap` response it's meant to bound. `validateFeeIntegrity` (api.ts) only rejects an implausibly
HIGH output (+2%, `FEE_NATIVE_SOURCES` only). A tampered/degraded `/swap` response with a tiny
`toAmount` produced a tiny floor with nothing generic in the way. Closed for every source: `/swap`
output must be consistent with the `/price` quote the user accepted.

### Formula (minimum-output.ts)
`floor = quoteToAmount * (10000 - slippageBps - TOLERANCE_BPS) / 10000` (BigInt floor division,
mirrors `deriveMinimumOutput`'s own bps arithmetic). Throws `StaleOrTamperedSwapError` when
`swapToAmount < floor`. `TOLERANCE_BPS = 50` (0.5%, named `SWAP_QUOTE_TOLERANCE_BPS`) — absorbs quote
age (gap between `/price` and `/swap`) + ordinary routing drift; far tighter than the ceiling's 2%
because a floor should track its own quote closely, whereas the ceiling has to tolerate an output
landing anywhere up to a real price move. Skip list mirrors `validateFeeIntegrity`'s exactly
(`uniswapv3`, `curve` — live on-chain pools, quote can legitimately go stale by execution time;
`cowswap` — intent-based, a solver fill above/below the indicative quote is not tampering).

### quoteToAmount availability (useSwap.ts)
Single call site: `SwapBox.tsx:232` → `useSwap(..., meta?.best.toAmount, ...)`. Undefined while a
quote is loading/refreshing or absent. On that path the new check is skipped with one structured
`console.warn` and the swap proceeds unblocked (pre-existing behaviour, not newly gated). CoW's own
flow (`executeCowSwap`) never threads `quoteToAmount` at all — moot anyway, `cowswap` is skip-listed.
