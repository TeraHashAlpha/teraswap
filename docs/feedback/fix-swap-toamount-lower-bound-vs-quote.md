## Feedback — fix/swap-toamount-lower-bound-vs-quote

### Task checklist
- [x] C1 (c08cceb) — `assertSwapConsistentWithQuote` + `StaleOrTamperedSwapError` (minimum-output.ts),
      wired in `useSwap.ts` right before `deriveMinimumOutput`
- [x] C2 (08838ad) — tests (minimum-output.test.ts boundary/skip/malformed/positive-control;
      useSwap.test.ts end-to-end block/pass/no-fallback)
- [x] C3 — exclude from the 9O fallback walk (mirrors PriceGuardError) + this evidence

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
`cowswap` — intent-based, a solver fill above/below the indicative quote is not tampering). No
shared export between api.ts and minimum-output.ts (api.ts pulls server-only adapter modules this
client hook must not bundle) — the list is duplicated and kept in sync manually, same trade-off
already accepted for `FEE_INCOMPATIBLE_SOURCES` vs `FEE_NATIVE_SOURCES` in constants.ts.

### quoteToAmount availability (useSwap.ts)
Single call site: `SwapBox.tsx:232` → `useSwap(..., meta?.best.toAmount, ...)`. Undefined while a
quote is loading/refreshing or absent. On that path the new check is skipped with one structured
`console.warn` and the swap proceeds unblocked (pre-existing behaviour, not newly gated). CoW's own
flow (`executeCowSwap`) never threads `quoteToAmount` at all — moot anyway, `cowswap` is skip-listed.

### C3 — UX
`errorMessage` already flows into SwapBox.tsx's generic error box (line 870, `effectiveError`) — the
same box PriceGuardError's dedicated block sits beside — so `StaleOrTamperedSwapError`'s message
surfaces there with ZERO SwapBox.tsx changes. What needed wiring: the message is fully self-describing
(includes the −X% and "please review and try again"), so no separate deviation state was added — that
would duplicate what the string already says. The one real behaviour change is excluding it from the
9O fallback walk (useSwap.ts catch block), exactly like PriceGuardError: retrying another source would
just repeat a fetch already known to be untrustworthy; the user must see why before anything retries.
Pinned by "does NOT trigger the 9O fallback walk" (useSwap.test.ts).

### Evidence
**1. Hunks** — helper: `minimum-output.ts` new `assertSwapConsistentWithQuote`/`StaleOrTamperedSwapError`
(commit c08cceb, +99 lines, end of file). Call site: `useSwap.ts` lines ~476-499, right before
`deriveMinimumOutput`. Fallback exclusion: `useSwap.ts` catch block, `!(err instanceof
StaleOrTamperedSwapError)` added alongside the existing `PriceGuardError` exclusion.

**2. Tests** — `minimum-output.test.ts`: 44 tests, was 16 on origin/main (+28 for the new function —
boundary at 0/5/49.99% slippage, skip list, AGGREGATOR_META positive control, malformed-input parity).
`useSwap.test.ts`: 40 tests, was 25 on origin/main (+15 — block, pass, no-fallback, 13-source
positive-control loop via `it.each`, plus the pre-existing `swapResponse().toAmount` override fix).
Combined 85/85 passing. Full suite: 4238/4238 passing (284 files) on this branch. `npx eslint` on all
4 touched files: 0 new warnings — `useSwap.ts` unchanged at 8 pre-existing warnings (none on touched
lines, verified via `git stash` diff against origin/main), the other 3 files at 0. `tsc --noEmit`: clean.

**3. Source × quoteToAmount × checked?**

| source | quoteToAmount reaches useSwap? | checked by assertSwapConsistentWithQuote? | reason |
|---|---|---|---|
| 1inch, 0x, velora, odos, kyberswap, uniswap, openocean, sushiswap, balancer, bebop, teraswap_order_engine | yes, via `SwapBox.tsx:232` `meta?.best.toAmount` (may be `undefined` pre-quote/refresh → warn+proceed) | yes | default path |
| uniswapv3 | yes, same as above | no (skip list) | live on-chain pool — quote can legitimately go stale by execution time |
| curve | yes, same as above | no (skip list) | same as uniswapv3 |
| cowswap | never — `executeCowSwap` doesn't thread `quoteToAmount` at all | no (architecturally out of scope + skip list) | intent-based; solver fill above/below indicative quote is not tampering |
