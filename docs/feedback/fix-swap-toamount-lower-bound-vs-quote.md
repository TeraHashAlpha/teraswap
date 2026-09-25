## Feedback — fix/swap-toamount-lower-bound-vs-quote

### Task checklist
- [x] C1 (c08cceb) — `assertSwapConsistentWithQuote` + `StaleOrTamperedSwapError` (minimum-output.ts),
      wired in `useSwap.ts` right before `deriveMinimumOutput`
- [x] C2 (08838ad) — tests (minimum-output.test.ts boundary/skip/malformed/positive-control;
      useSwap.test.ts end-to-end block/pass/no-fallback)
- [x] C3 — exclude from the 9O fallback walk (mirrors PriceGuardError) + this evidence
- [x] R2-C1 (1bc94f2) — H-01: `quoteToAmount` (+ `chainId`) into `executeStandardSwap`'s deps;
      missing quote = `StaleOrTamperedSwapError`, no warn path
- [x] R2-C2 (f0a6b62) — H-02: per-leg + aggregate floor in `useSplitSwap.ts`; a breach aborts the
      whole split
- [x] R2-C3 (3bf238c) — M-01/M-02 (skip list = `uniswapv3` only) + L (diagnostic) + claim corrections
- [x] R2-C4 — tests (21 new) + this evidence

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

---

## Audit round 1 — findings

0C / 2H / 2M / 3L. **The Auditor's verbatim report is not in this file: the owner had not pasted it
when round 2 was implemented.** What was worked is the Architect's transcription in the round-2
prompt — H-01 (`quoteToAmount` undefined in the normal SwapBox flow, so a guard wired as
warn-and-proceed never ran), H-02 (split routes never reach the check), M-01 (`cowswap` is a dead
exemption), M-02 (the `curve` skip reason does not hold), L (wrong `UnusableQuoteError` diagnostic;
three wrong feedback claims; the unmentioned `:726` warning). Paste the verbatim report above this
paragraph when available; every finding above is addressed and ticked.

## Round 2 — evidence

**1. H-01 call-site trace + the fail-closed hunk.** `SwapBox.tsx` needed **no change**: `:232`
already passes `meta?.best.toAmount` — the same value `:485-487` renders as the expected output and
`:637`/`:664` gate the swap buttons on. The break was one line lower, inside the hook:
`executeStandardSwap`'s `useCallback` dep array (`useSwap.ts:747`) omitted `quoteToAmount`, so the
memoized closure kept the value from before the quote resolved. Fixed there; the call site is
unconditional now:
```
-      }, [tokenIn, tokenOut, address, amountIn, slippage, sendTransaction])
+      }, [tokenIn, tokenOut, address, amountIn, slippage, sendTransaction, quoteToAmount, chainId])
-      if (quoteToAmount) { assertSwapConsistentWithQuote({ ... }) } else { console.warn(...) }
+      assertSwapConsistentWithQuote({ quoteToAmount, swapToAmount: swapData.toAmount, slippagePercent: slippage, source })
```
`chainId` was missing from the same array and is read all through the callback — a swap started after
a chain switch could have been built against the previous chain's config. Fixed in the same line.

**2. H-02 split hunk.** `useSplitSwap.ts`: per leg, `assertSwapConsistentWithQuote({ quoteToAmount:
leg.quote?.toAmount, swapToAmount: swapData.toAmount, slippagePercent: slippage, source })` beside
the existing ceiling check (~:325); the per-leg `catch` rethrows nothing for a
`StaleOrTamperedSwapError` and instead clears the frozen plan, sets `error` and returns (~:425), so
one bad leg blocks the whole split; and once on the total before `awaiting-review` (~:455) with
`source: null` (source-agnostic → never skip-listed), summed over the signable legs, any malformed
amount collapsing that side to `null` → refusal.

**3. Tests** — 21 new, all green. `useSwap.test.ts` 41 → 58: *"a quote that resolves AFTER the first
render still bounds the swap (no stale closure)"*, *"no accepted quote at all is a refusal, not a
warning"*, *"the accepted quote also reaches validateFeeIntegrity"*, a 12-source × (halved | missing)
outcome table, and *"cowswap reaches no floor at all"*. `useSplitSwap.test.ts` 33 → 37: all-legs-good
passes, one bad leg blocks the whole split, a quote-less leg is refused, and *"the AGGREGATE catches
what a skip-listed leg bypasses"*. `minimum-output.test.ts` 44 → 50.

*Non-vacuity, measured.* Disabling the `assertSwapConsistentWithQuote` call in `useSwap.ts`:
`16 failed | 42 passed (58)` — both wiring tests, all 11 checked sources in the table, and the two
round-1 floor tests. `uniswapv3` stays green there, which is the skip list doing the work rather
than an absent check. Disabling only the aggregate call in `useSplitSwap.ts`: `1 failed | 36 passed
(37)` — exactly the aggregate test, so it is load-bearing and not a restatement of the per-leg pass.

**4. Deltas.** `git diff --stat 4da633e..HEAD`: 7 files, +503 / −86. Full suite **4262/4262 passing,
284 files** (base `af2da77`, this branch's merge-base with `origin/main`: 4194/4194, 284 files —
measured, not quoted). `tsc --noEmit` clean. Lint delta **0**: `useSwap.ts` 8 → 8 warnings (the
`:726` "missing dependencies: 'chainId' and 'quoteToAmount'" one is gone; an "unnecessary dependency:
'sendTransaction'" observation it had been masking took its place — pre-existing, left alone as out
of scope), and the other 5 touched files at 0.

### Concern — the effective tolerance is ~40 bps, not 50
On a fee-routed source the `/swap` build is fetched for the post-fee net amount (`useSwap.ts:339`,
`useSplitSwap.ts` `apiAmount`) while the quote is gross, so a legitimate response already sits
~10 bps (`FEE_BPS`) below the accepted quote. That leaves ~40 bps for quote age plus routing drift
on top of the user's slippage. A volatile pair with a slow confirm could reach it; the failure mode
is a refusal with "refresh the quote and try again", never a bad fill. Raise
`SWAP_QUOTE_TOLERANCE_BPS` or subtract `FEE_BPS` explicitly if telemetry shows false blocks.

### Concern — a uniswapv3 split leg can now block the whole split
The aggregate is source-agnostic by design, so a legitimate uniswapv3 fee-tier switch mid-split
(`adapters/uniswapv3.ts:247-271`) can drag the total past the floor and refuse the plan even though
the leg itself is exempt. Fail-closed was the ruling; flagging the trade-off.

### Edge case — W2-L-01's throw site moved
`deriveMinimumOutput`'s `UnusableQuoteError` for a malformed `/swap` `toAmount` is now raised one
step earlier by `assertSwapConsistentWithQuote`'s swap-side guard (same class, same outcome). Its own
throw stays reachable for skip-listed sources, so it is defence-in-depth rather than dead.

### Note — prompt scope named the wrong split file
The round-2 prompt scoped `src/hooks/useSplitRoute.ts` (+test). That hook only *analyses* the split
(it never sees a `/swap` response); the executing hook is `src/hooks/useSplitSwap.ts`, which is where
H-02 had to land. `useSplitRoute.ts` is unchanged.
