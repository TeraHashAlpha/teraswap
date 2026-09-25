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

### quoteToAmount availability (useSwap.ts) — CORRECTED in round 2
~~Undefined only while a quote is loading/refreshing; warn and proceed.~~ **Wrong, and it made the
check dead code.** `SwapBox.tsx:232` does pass `meta?.best.toAmount`, but `executeStandardSwap` is
memoized and its dep array omitted `quoteToAmount`, so the closure kept whatever the value was when
the callback was last rebuilt — token/amount/slippage change rebuilds it, a resolving quote does
not, so on the normal path it held `undefined` (or the previous amount's quote) forever. Fixed:
`quoteToAmount` (and `chainId`, missing from the same array) are now dependencies, and a missing
quote is a refusal, not a warning. CoW is unaffected either way — `executeCowSwap` is a separate
flow that never reaches this function.

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

**2. Tests** — `minimum-output.test.ts`: 44 tests, was 16 on origin/main. `useSwap.test.ts`: ~~40~~
**41** tests (measured at 4da633e), was 25 on origin/main. Combined 85/85 passing. Full suite:
4238/4238 (284 files); base af2da77 measures 4194/4194. See round 2 for the current figures.

~~`npx eslint`: 0 new warnings — none on touched lines.~~ **Materially incomplete.** The count was
0-delta, but `useSwap.ts:726` already carried `react-hooks/exhaustive-deps`: *"React Hook useCallback
has missing dependencies: 'chainId' and 'quoteToAmount'"* — i.e. the linter had already named the
exact defect this branch shipped, 20 lines below the new call site, and the evidence paragraph
reported "no warnings on touched lines" instead of reading it. Lesson recorded: a lint *count* delta
is not lint evidence when the change depends on a value a warning names.

**3. Source × quoteToAmount × checked?** (round-2 state)

| source | accepted quote reaches the check? | checked? | reason |
|---|---|---|---|
| 1inch, 0x, velora, odos, kyberswap, uniswap, openocean, sushiswap, balancer, bebop, teraswap_order_engine, **curve** | yes — `SwapBox.tsx:232` `meta?.best.toAmount`, now in `executeStandardSwap`'s deps; split legs via `leg.quote.toAmount` | yes | default path; missing quote = refusal |
| uniswapv3 | yes, same | no (skip list) | the /swap build RE-DETECTS the fee tier (`adapters/uniswapv3.ts:247-271`), so quote and swap can measure two different pools — structural, not drift |
| cowswap | never — `execute()` dispatches it to `executeCowSwap` (`useSwap.ts:1058-1059`); excluded from `SPLIT_ELIGIBLE_SOURCES` (`split-routing-types.ts:96`) | n/a | unreachable, so no longer skip-listed either (a dead exemption reads as a checked carve-out) |
| split total | yes — `source: null`, source-agnostic | yes | bounds a split even when a leg is exempt |
