## Feedback — P117 (pending commit)

### Assumption that turned out wrong
- Spec says "in the frontend confirmation callback (wherever `validateExecution`
  result is consumed and the PATCH to /api/log-swap is called), pass
  `mevSavingsActual: result.surplusWei` in the PATCH body". But `validateExecution`
  is a server-only module (RPC client, KV access, auto-disable side effects) and
  its HTTP route is bearer-token gated. The frontend has no path to consume
  `ExecutionValidation` directly without exposing the auto-disable side effects.

  Implemented two complementary writes instead:
  1. **Non-CoW path:** `/api/monitor/validate-execution` route (server-side)
     now writes `swaps.mev_savings_actual` directly via Supabase whenever
     `result.surplusWei` is non-null. The existing executor pipeline calls this
     endpoint after each on-chain confirmation, so all non-CoW sources get
     surplus persisted without exposing a public surplus endpoint.
  2. **CoW path:** `useSwap.ts` now calls `updateSwapStatus(...)` with the
     computed surplus on fulfilled CoW orders. Previously the CoW path computed
     `mevSurplusActualWei` but only stored it in component state — the row in
     `swaps` never got PATCHed at all on CoW fulfillment (the wagmi
     `swapConfirmed` effect only fires for `sendTransaction` flows).

### Edge case
- Existing CoW success path never called `updateSwapStatus` — the row stayed
  `pending` forever after a successful CoW order. Now confirmed via the new
  PATCH call. Not strictly in scope for P117 surplus instrumentation, but the
  spec required wiring `mevSavingsActual` into the PATCH for the CoW path, and
  this is the natural place.

## Feedback — P121 (commit abe54f2)

### Edge case
- Spec said the guard "must run BEFORE: fetchSwapFromSource call, Any rate
  limiting deduction (don't count invalid requests), Any logging to Supabase".
  The existing route ran the rate-limit check before body parsing, so the
  guard required reordering: circuit breaker → content-length → body parse
  → required-fields → source allow-list → rate limit → address/slippage.
  Confirmed via mock call counts in `route.test.ts` that an invalid source
  no longer touches `checkRateLimit` or `fetchSwapFromSource`.

### Test gap
- No pre-existing test file existed for `src/app/api/swap/route.ts` — the
  route had broad coverage from manual / integration testing but zero unit
  tests. Added `route.test.ts` for the guard; the rest of the route (price
  guard, R1 recipient check, SC-04 selector check) is still not unit-tested
  and may warrant a follow-up sprint item.

## Feedback — P122 (commit 34d190b)

### Edge case
- Six call sites all converted, but the previously-broken CoW PATCH from P117
  used five consecutive `undefined` placeholders to reach `mevSavingsActual` —
  the worst offender. The refactor also eliminated two `undefined, undefined`
  pairs in the fallback-poll branches (between `txHash, status` and `wallet`).
  Verified zero remaining via `git grep 'updateSwapStatus(' | grep 'undefined'`.

### Concern
- No test file directly exercises `updateSwapStatus`. The refactor is a pure
  signature change with no behavioural difference (PATCH body construction is
  unchanged), so the existing route + integration tests covering the PATCH
  endpoint catch any regression. If we add unit tests for analytics helpers
  in a future sprint, this is a good candidate to start with.

## Feedback — P134 (commit 4b52342)

### Edge case
- Synthetic single-row fallback (no `order_executions` rows but order has
  `tx_hash`) cannot populate `amount_in`. The orders table column subset I'm
  fetching exposes `amount_out` for the executed amount, but the original
  input amount lives in the on-chain order struct
  (`order.amountIn` in the UI, sourced from the EIP-712 signed struct in the
  `orders.order` jsonb column). Legacy orders therefore render as
  "— → 1.5 ETH @ $X" on the row. Acceptable per the "graceful fallback for
  missing fields" rule, but worth flagging — if the orders table adds an
  `amount_in` mirror column (or we expose `order_struct->>'amountIn'`) we can
  backfill this on the row.

### Concern
- `npm run lint` (`next lint`) is broken on this checkout because the repo
  path contains a space ("dex-aggregator 2"). Next mis-parses the second
  path segment as a directory arg and errors with
  *"Invalid project directory provided, no such directory: …/lint"*. Verified
  lint cleanliness via direct `npx eslint <changed files>` instead. Not
  introduced by this prompt — affects CI parity if any job runs
  `npm run lint` from a path with whitespace. Workaround:
  `npx next lint -- --dir src` or call `npx eslint` directly.

- `react-hooks/set-state-in-effect` warning on
  `ExecutionTimeline.tsx:160` (`setLoading(true)` inside the `useEffect` that
  triggers the fetch). The same pattern existed in the previous version of
  the file and is preserved to keep this prompt scope-clean, but the new
  React Compiler rules will keep flagging it. A follow-up refactor to fetch
  via a reducer or `useSyncExternalStore` would silence it.

## Feedback — P135 (commit c91bf5b)

### Assumption that turned out wrong
- Spec for the MEV toggle (SwapBox.tsx line 623) said "extend tappable area
  with padding around the h-6 w-10 toggle track". Implementing literal
  `p-2` on the button itself (even with `box-content` + `-m-2` to preserve
  layout) expands the *painted* track because the background-color extends
  to the padding-box — that's a visible desktop change since the toggle
  uses an inline `backgroundColor` style. Switched to an invisible
  `<span aria-hidden absolute -inset-2 sm:inset-0>` child that extends
  the hit area only (events bubble back to the parent button via pointer
  bubbling). Behaviourally equivalent to the spec; visually inert on
  desktop. Architect should confirm this substitution.

### Edge case
- Global tap feedback (`button:active / a:active / [role="button"]:active
  { transform: scale(0.97) }`) was applied without an `@media (hover: none)`
  gate, matching the spec literally ("Global"). This means desktop mouse
  clicks now also get the 3% scale dip. The existing file convention
  (`-webkit-tap-highlight-color`, line 286-290) gates similar styling to
  `@media (hover: none)`. If desktop mouse-click scale feels off, the
  fix is to wrap the new selectors in the same media query.

- `Footer.tsx` `py-2 sm:py-0` was applied to every link including the
  icon-only X (Twitter) link, since the spec said "each link" and the
  uniform treatment keeps tap rows aligned. The X link becomes a taller
  row on mobile (icon + 8px top + 8px bottom). Acceptable, but the
  architect may prefer the icon-only link to keep its original size.

### Concern
- 20 pre-existing eslint warnings in `SwapBox.tsx` (mostly
  `react-hooks/set-state-in-effect` and `exhaustive-deps`) are unchanged
  by this prompt. Verified via the `0 errors` line in the eslint summary
  — none of my edits introduced new warnings.
## Feedback — P139 (commit pending)

### Edge case
- Server-side R1 check in `src/app/api/swap/route.ts` was validating
  calldata recipient against `from`. The prompt said "no change needed"
  for R1, which is true for the client-side check (uses `address`), but
  with this change `from` becomes `FEE_COLLECTOR_ADDRESS` when FeeCollector
  routing is active — making the server R1 expect FC as the recipient,
  which fails. Updated to validate against `recipient || from` so the
  expected destination is the user wallet when present, falling back to
  `from` for direct (non-FeeCollector) routes. This preserves the
  security guarantee (calldata always validated against the intended
  user destination) and matches what the adapter is told to encode.

### Concern
- `simulateSwapTx` matches custom errors by both decoded name and 4-byte
  selector hex. The selector match is a defensive fallback for RPC
  providers that don't auto-decode; if a future contract reuses the same
  error names with different signatures, the name-string match could be
  ambiguous. Mitigation: the selector match is stricter and would only
  fire for the exact `RouterNotWhitelisted()` / `SwapFailed()` / etc.
  signatures.
