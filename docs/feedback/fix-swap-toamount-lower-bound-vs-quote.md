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
- [x] R3-C1 (dc8acb1) — ruling (3): fee-adjusted basis, `routeViaFeeCollector` required at every call site
- [x] R3-C2 (329ee74) — ruling (2): per-source quote map, fallbacks floored against their own quote
- [x] R3-C3 (471cbe0) — rulings (3)/(4) tests + both probes
- [x] R3-C4 — ruling (1): M-pair corrected, superseded round-2 answers replaced
- [x] Auditor round 2 — L-01 pinning test (per-leg floor independently load-bearing)
- [x] Auditor round 2 — L-02 pinning tests (aggregate single-netting + floor rounds down)
- [x] Auditor round 2 — M-01 recorded as a follow-up (no production change this round)

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

0C / 2H / 2M / 3L. **The Auditor's verbatim report is not in this file — the owner had not pasted it.**
Paste it above this paragraph when available. The findings as ruled (Architect, round 3 (1), after the
round-2 feedback flagged that the prompt's M-pair did not match the review record):

- **H-01** — `quoteToAmount` never reached the check in the normal SwapBox flow, and a missing quote
  only warned, so the guard could not fire for a real user.
- **H-02** — split routes reached the check nowhere.
- **M-01** — the `uniswapv3` skip reason did not hold as written. **Ruled: uniswapv3 STAYS
  skip-listed**, on the tier-re-detection evidence below, and ruling (4) extends the same skip to
  split legs. The reason, not the entry, was what needed fixing.
- **M-02** — the 9O fallback walk floored a fallback source against the BEST source's quote. **Fixed
  in round 3** (per-source quote map) — see below.
- **L** — wrong `UnusableQuoteError` diagnostic; three wrong feedback claims; the unmentioned `:726`
  warning.

The round-2 prompt transcribed the M-pair as `cowswap` (dead exemption) and `curve` (reason does not
hold) instead. Both of those changes were ordered and were made — they are real and they stand — but
they are prompt-ordered changes, not the Auditor's M findings.

## Round 2 — evidence

**1. H-01 call-site trace + the fail-closed hunk.** `SwapBox.tsx` needed no change *in round 2*
(ruling (2) later replaced that argument with a per-source map — see Round 3): `:232`
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
what a skip-listed leg bypasses"*. `minimum-output.test.ts` 44 → **47** (the round-2 draft of this line said 50 — measured, wrong, corrected).

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

### ~~Concern — the effective tolerance is ~40 bps, not 50~~ — FIXED by ruling (3)
On a fee-routed source the `/swap` build is fetched for the post-fee net amount (`useSwap.ts:339`,
`useSplitSwap.ts` `apiAmount`) while the quote is gross, so a legitimate response already sits
~10 bps (`FEE_BPS`) below the accepted quote. That leaves ~40 bps for quote age plus routing drift
on top of the user's slippage. A volatile pair with a slow confirm could reach it; the failure mode
is a refusal with "refresh the quote and try again", never a bad fill. Raise
`SWAP_QUOTE_TOLERANCE_BPS` or subtract `FEE_BPS` explicitly if telemetry shows false blocks.
**Ruled: subtract it.** `feeAdjustedQuoteBasis` now nets `FEE_BPS` out of the basis at every call site,
so the full 50 bps is available for quote age and real drift.

### Concern — a uniswapv3 split leg can still block the whole split (accepted)
The aggregate is source-agnostic by design, so a legitimate uniswapv3 fee-tier switch mid-split
(`adapters/uniswapv3.ts:247-271`) can drag the total past the floor and refuse the plan even though
the leg itself is exempt per ruling (4). Fail-closed and source-agnostic were both ruled; this is the
residual trade-off they imply, restated here so it is on the record rather than open.

### Edge case — W2-L-01's throw site moved
`deriveMinimumOutput`'s `UnusableQuoteError` for a malformed `/swap` `toAmount` is now raised one
step earlier by `assertSwapConsistentWithQuote`'s swap-side guard (same class, same outcome). Its own
throw stays reachable for skip-listed sources, so it is defence-in-depth rather than dead.

### Note — prompt scope named the wrong split file
The round-2 prompt scoped `src/hooks/useSplitRoute.ts` (+test). That hook only *analyses* the split
(it never sees a `/swap` response); the executing hook is `src/hooks/useSplitSwap.ts`, which is where
H-02 had to land. `useSplitRoute.ts` is unchanged.

## Round 3 — Architect rulings (1)-(4)

**(1) M-pair** — corrected in the findings section above. `uniswapv3` stays skip-listed; the ruling
accepts the tier-re-detection reason (`adapters/uniswapv3.ts:247-271`, both branches overwrite the
quote's tier with `detection.bestFee`, so a tier switch has quote and swap measuring different pools).

**(2) Fallbacks floored against their own quote** — `useSwap`'s 5th argument is now the per-source map
SwapBox already had, and the executing source resolves its own accepted quote:
```
-  quoteToAmount?: string,                                    // hook signature
+  quoteToAmountBySource?: QuoteToAmountBySource,
+      const quoteToAmount = quoteToAmountBySource?.[source]  // inside executeStandardSwap
-    useSwap(tokenIn, tokenOut, amountIn, slippage, meta?.best.toAmount, bestNonCowGasUsd)
+    const quoteToAmountBySource = useMemo<QuoteToAmountBySource>(
+      () => Object.fromEntries((meta?.all ?? []).map((q) => [q.source, q.toAmount])), [meta])
+    useSwap(tokenIn, tokenOut, amountIn, slippage, quoteToAmountBySource, bestNonCowGasUsd)
```
Fallback candidates come from that same `meta.all` (`orderExecutableFallbacks` → `swap-fallback.ts:35`),
so every reachable source has its own quote; absent = refused, fail-closed, and unreachable in
production. The ceiling reads the same resolved value, so a fallback is no longer measured against a
higher quote than it gave — `validateFeeIntegrity`'s own formula and tolerance are untouched. Round-1
fallback UX is otherwise unchanged (a `StaleOrTamperedSwapError` still never walks).

**(3) Fee-adjusted basis** — `feeAdjustedQuoteBasis(quote, routeViaFeeCollector)`, one exported helper,
reused by all three call sites:
```
  basis = routeViaFeeCollector ? quote * (10000 - FEE_BPS) / 10000 : quote
  floor = basis * (10000 - slippageBps - SWAP_QUOTE_TOLERANCE_BPS) / 10000
  throws  ⟺  swapToAmount < floor
```
`routeViaFeeCollector` is a REQUIRED param, so the compiler named all four call sites instead of a
default picking silently. The split aggregate nets the fee **per leg** (a split can mix fee-routed and
direct legs) and then passes `false` so the helper cannot net it twice. The deviation in the error copy
still measures against the GROSS quote — that is the figure the user accepted.

**(4) Split** — the per-leg call passes `source`, so a `uniswapv3` leg is skip-listed exactly as on the
single path; the aggregate keeps `source: null` and stays source-agnostic.

### Round-3 evidence
16 new tests, all green. `useSwap.test.ts` 58 → 62 (honest −20% fallback executes; a fallback below its
OWN quote is still refused; no quote in the map = refused; the ceiling sees the fallback's own quote).
`minimum-output.test.ts` 47 → 57 (basis unit pins + fee-routed boundary at 994_005/994_004, and the
same amount refused on a direct route). `useSplitSwap.test.ts` 37 → 39 (a uniswapv3 leg 80% low is not
refused and the plan still freezes; a fee-routed split at 497_200 per leg, between the netted floor
497_002 and the gross 497_500).

*Probes.* Netting removed → 6 failures across both files, the split one included. Per-source resolution
reverted to round-2 behaviour → exactly the 2 fallback tests fail. Suite **4278/4278 (284 files)** vs
4194 at merge-base `af2da77`. `tsc` clean. Lint delta 0 on all 7 touched files (`useSwap.ts` 8 → 8,
`SwapBox.tsx` 15 → 15 — measured against `ae205dd` — the rest 0).

### Edge case — the aggregate can refuse by 1 wei where every leg passes
The per-leg floor and the aggregate floor are both BigInt floor divisions, and flooring a sum is not
the sum of floors. Two legs each sitting EXACTLY on their own floor can land 1 wei under the aggregate
floor and refuse the plan (measured: 497_002 × 2 = 994_004 against a 994_005 aggregate floor). Left
as-is — it is fail-closed, needs both legs to be wei-exact on the boundary, and the alternative
(comparing against a sum of per-leg floors) would make the aggregate source-dependent, which ruling
(4) rules out.

## Auditor round 2 — 0C/0H/1M/2L, approvable. Tests-only follow-up (no production changes)

**Auditor findings (2026-09-28, head `7cbc532`):**
- **M-01** — a 9O fallback reads the quote map from the LATEST closure
  (`executeStandardSwapRef`, `useSwap.ts:746/777`) while the fallback list is captured at click, so a
  15s `useQuote` refresh that drops the fallback source mid-walk falsely refuses it ("no accepted
  quote"). The `"unreachable by construction"` comment (`:467-469`) is wrong.
- **L-01** — the per-leg split floor (`useSplitSwap.ts:343`) had no pinning test: disabled →
  4278/4278 still green (the existing "one leg blocks the whole split" test passes via the
  aggregate, not the per-leg call it was meant to pin).
- **L-02** — aggregate double-netting and a ceil'd floor also survived 4278/4278.

**M-01 — recorded as a follow-up, not fixed here (tests-only commit, no production changes).**
`executeStandardSwapRef` closes over `quoteToAmountBySource` fresh on every render (ruling (2),
round 3), but the 9O fallback walk's candidate LIST is captured once when the walk starts
(`useSwap.ts:467-469`— comment claims this makes a stale-map read "unreachable by construction";
the Auditor's read is that a `useQuote` refresh mid-walk can still drop a source from the map
between candidate-list capture and that candidate's turn, and the ref read then sees the NEW map,
not the one the fallback list was captured against — the candidate exists in the frozen list but
not in the fresh map, and the walk reports a false "no accepted quote" refusal instead of trying
the next candidate or accepting the fallback against ITS OWN accepted quote). Fix would need to
freeze `quoteToAmountBySource` alongside the fallback candidate list at walk-start (or accept a
race-loss as "quote changed, restart" rather than "no accepted quote") — a production change, out
of scope for this tests-only round.

### L-01 — the per-leg floor is independently load-bearing

New test (`useSplitSwap.test.ts`, describe `[Auditor round 2, L-01]`): both legs quoted 500M; 1inch
responds 950M (over), 0x responds 50M — exactly 10% of its own 500M quote. Summed: 950M + 50M =
1_000_000_000, exactly 500M + 500M — the source-agnostic aggregate sees **zero** shortfall and
would freeze the plan for review on its own. Only the per-leg call (`source` threaded through, so a
skip-listed source like `uniswapv3` stays exempt) can see the 0x leg individually cratered.

*Mutation probe, measured (temporarily edited `useSplitSwap.ts`, ran the suite, reverted — `git
diff` clean afterward, confirmed below):* disabling the per-leg `assertSwapConsistentWithQuote`
call (lines 343-349) → **exactly 1 failure**, this new test — `42 passed | 1 failed (43)`. The
pre-existing "ONE leg below its floor blocks the WHOLE split" test (line ~876) stays green under
the same mutation, confirming the Auditor's finding that it pins the OUTCOME, not the per-leg
mechanism.

### L-02 — aggregate: single netting, floor rounds down

New describe block (`[Auditor round 2, L-02]`), 3 tests, all built on a per-leg quoted share of
`333_333_337` (not a multiple of 10_000, so neither the per-leg fee-netting division nor the final
floor division divides exactly) and expected floors computed from the REAL exported helpers
(`feeAdjustedQuoteBasis`, `SWAP_QUOTE_TOLERANCE_BPS` — imported, not reimplemented, so the tests
can't silently drift from the production formula):
- **sanity** — asserts the chosen boundary's divisions actually have a nonzero remainder (otherwise
  round-down vs round-up would be indistinguishable).
- **[round-down]** — two leg responses summing to EXACTLY the aggregate floor (each individually
  clearing its own per-leg floor, so the per-leg check never fires) still clears — `awaiting-review`.
- **[single-netting]** — both legs respond AT their own per-leg floor exactly (passes individually);
  their sum lands 1 unit BELOW the aggregate floor (flooring a sum ≠ summing floors, the same
  documented trade-off as the round-3 edge case above) and is refused.

*Mutation probes, measured (temporarily edited, ran, reverted — confirmed clean below):*
- **Double-netting** (`useSplitSwap.ts:508`, `routeViaFeeCollector: false` → `true`, netting the
  already-per-leg-netted `quotedBasisTotal` a second time): **exactly 1 failure**, the
  `[single-netting]` test — `42 passed | 1 failed (43)`.
- **Round up** (`minimum-output.ts:209`, floor division → `(numerator + 9_999n) / 10_000n`):
  **exactly 1 failure**, the `[round-down]` test — `42 passed | 1 failed (43)`.

Each mutant fails exactly the test built for it and nothing else — the three probes don't overlap
(lesson from round 2: "run per-rule mutants on the FULL suite; a feedback probe of one rule says
nothing about its sibling" — here each probe ran the full `useSplitSwap.test.ts` file, not a single
`it`).

### Evidence — counts

`git diff --stat 7cbc532`: 2 files — `src/hooks/useSplitSwap.test.ts` (test code) and this feedback
doc. `git diff --stat 7cbc532 -- ':!src/hooks/useSplitSwap.test.ts' ':!docs/feedback/...'` is empty
— confirmed no production file touched. `useSplitSwap.test.ts`: **39 → 43** (4 new: L-01 ×1, L-02
×3). Full suite: **4278 → 4282 (284 files, 0 fail)**. `tsc --noEmit` clean. `npx eslint
src/hooks/useSplitSwap.test.ts`: 0 warnings, 0 errors.
