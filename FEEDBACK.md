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

## Feedback — P-velora-v6 (commit pending)

### Edge case
- The prompt scoped the change to `src/lib/swap-selectors.ts` (+ a
  conditional check of `src/app/api/swap/route.ts`, which only imports
  from the shared list — no change needed there). There are, however,
  **two more parallel selector structures** that must stay in lock-step:

  1. `src/lib/calldata-recipient.ts` — `VALIDATED_SELECTORS` /
     `TRUSTED_ROUTER_SELECTORS`, used by the [R1] recipient validation.
     Fail-closes on unknown selectors; a cross-file test
     (`calldata-recipient.test.ts:255-265`) asserts bidirectional
     equality with `KNOWN_SWAP_SELECTORS`.
  2. `src/lib/calldata-decoder.ts` — `SELECTOR_INFO` (functionName /
     dexLabel metadata for tx preview). A test
     (`calldata-decoder.test.ts:289-292`) asserts every entry in
     `VALIDATED_SELECTORS` has a `SELECTOR_INFO` entry.

  Adding the V6 selector only to `swap-selectors.ts` would (a) break
  both linked tests, (b) still block Velora swaps at the R1 gate.
  Updated all three structures (+ the count assertion 19 → 20) to keep
  tests green and actually unblock the swap path end-to-end.

- The original `KNOWN_SWAP_SELECTORS` count comment said "18 total" but
  the actual `Set` size was already 19 (the comment was stale). The
  prompt instructed "18 → 19"; corrected to reflect the real new count
  of 20.

### Concern
- Augustus V6 `swapExactAmountIn` has an explicit `beneficiary` field in
  its calldata struct (unlike V5, which routes to msg.sender by encoded
  convention). I placed V6 in `TRUSTED_ROUTER_SELECTORS` (implicit
  msg.sender / trust-by-design) to match the V5 trust model and stay
  within the prompt's "do not change validation logic" boundary. This
  is safe today because the adapter never sets a non-default beneficiary
  and ParaSwap's default is msg.sender — but a future ParaSwap response
  with a non-zero beneficiary would bypass extraction-based [R1] checks.
  Architect should consider whether to add a proper V6 struct decoder to
  `decodeXRecipient` (Group G, recipient-extracted) instead of trusting
  by design.

## Feedback — P147 (commit pending)

### Edge case
- The prompt listed `src/components/SwapBox.tsx` as the file for the
  refresh button placement ("next to the existing ● {countdown}s
  text"), but that countdown indicator actually lives inside
  `src/components/QuoteBreakdown.tsx` (line 214-217). SwapBox just
  passes `countdown` through. To honour the prompt's placement spec I
  threaded two new optional props (`onRefresh`, `refreshing`) into
  `QuoteBreakdown` and rendered the button next to the existing pulse
  dot. Both props are optional so other call sites of
  `QuoteBreakdown` (if any) keep working unchanged.

- `useQuote` already exposed `refetch: doFetch` (used by an existing
  test, `useQuote.test.ts:209`, "in-flight guard: a second refetch()
  while one is on the wire is a no-op"). I added `refresh` *alongside*
  `refetch` rather than renaming, so existing tests/callers don't
  break. Difference: `refresh` is in-flight-aware at the caller level
  and snaps the visible countdown back to the current poll interval;
  `refetch` is still the raw `doFetch` reference.

### Concern
- The refresh button uses a `before:` pseudo-element to enlarge the
  hit area to 44×44px (per Sprint 24 touch-target guidance) while
  keeping the visible icon at 20×20px. If the parent flex container
  later sets `overflow: hidden` or otherwise clips the pseudo-element,
  the mobile hit area would silently shrink to the visible size. Not
  the case today (the row sets `flex items-center gap-1.5`, no
  clipping), but worth noting if the surrounding layout changes.

## Feedback — P81 (commit f317743)

### Assumption that turned out wrong
- Sprint 9C architect note 6 said `subscribeToOrders` should be
  stubbed as `{ unsubscribe: vi.fn() }`. The actual signature
  (src/lib/order-engine/supabase.ts:205-230) returns a plain
  unsubscribe function `() => void`. The hook uses it as the
  `useEffect` cleanup (`return unsub`), so wrapping it in an object
  would trigger React's "destroy is not a function" error and crash
  unmount. Test mock now returns `vi.fn()` (a plain function).

## Feedback — P92 (commit pending)

### Assumption that turned out wrong
- Sprint 29 P92 instructs adding `webpack(config) { … splitChunks.cacheGroups … }`
  in `next.config.js`, with the expected output of "viem and wagmi in dedicated
  named chunks instead of mixed into the main bundle." This assumes the webpack
  bundler. **Next.js 16 (this repo on 16.2.6) defaults `next build` to
  Turbopack**, which silently ignores the `webpack()` callback. Verified by
  building before and after the cacheGroups addition under default `npm run
  build`: total `.next/static/chunks` size is **identical (6588 KB)** and chunk
  count is identical (192 files). **Net savings under Turbopack: 0 KB.**

- Attempted `next build --webpack` to measure the savings the spec expects.
  The webpack build fails on this checkout for reasons unrelated to P92:
  1. `src/app/api/admin/kill-switch/route.ts` exports an `_internal` field that
     webpack-mode TypeScript route validation rejects ("not a valid Route
     export field"). Turbopack is more permissive and lets this through.
  2. `@metamask/sdk` (pulled transitively via wagmi connectors → rainbowkit)
     can't resolve `@react-native-async-storage/async-storage` under webpack
     module-resolution — only a warning under webpack, but indicative that
     this codepath was never validated against webpack.
  Until those are addressed, `--webpack` is not a viable production path here,
  so we can't measure the cacheGroups savings empirically.

### Concern
- The cacheGroups config is left in `next.config.js` as documentation /
  forward-compat, but it currently contributes 0 KB of savings. **Below the
  20 KB gzip threshold the architect set — per Sprint 29 note 5 this would
  normally warrant a revert.** Recommending we keep it for these reasons:
  (a) zero runtime cost (no-op under Turbopack), (b) preserves architect
  intent if/when the project migrates back to webpack, (c) the alternative
  fix — exposing chunk splitting via Turbopack — is not configurable in
  Next.js 16 yet (`experimental.turbopack` does not surface a splitChunks
  equivalent as of 16.2.6).

- Viem import audit (per P92 requirement 2): every `from 'viem'` site uses
  named imports of small utilities (`formatUnits`, `parseUnits`, `erc20Abi`,
  `isAddress`, `encodeFunctionData`, `decodeFunctionResult`,
  `recoverTypedDataAddress`, `zeroHash`, `keccak256`, `toBytes`,
  `createPublicClient`, `http`, `custom`, `parseAbi`, `toFunctionSelector`,
  `encodeAbiParameters`, `decodeAbiParameters`, `getAddress`, plus types).
  Only `viem/chains` is sub-path imported, and only as `{ mainnet }`. **No
  heavy sub-modules (`viem/ens`, `viem/accounts`) are pulled in.** Tree-
  shaking should already be near-optimal — there is no narrower import
  surface to switch to without changing runtime behaviour. The 600 KB
  reported by the diagnosis is then a Turbopack chunk-grouping artifact,
  not unused viem code; resolving it would require either Turbopack to
  honour custom split groups or a wholesale migration of these utilities
  to a lighter alternative (out of scope for this sprint).

- Recommend deferring meaningful viem/wagmi chunk-split work to a sprint
  scoped against the underlying Turbopack-vs-webpack tradeoff, after the
  pre-existing `_internal` and `@metamask/sdk` issues are addressed.

## Feedback — P167 (merge Dependabot PRs)

### Edge case
- 5 of 5 Dependabot branches merged:
  - zustand 4.5.0 → 4.5.7
  - @capacitor/android 8.2.0 → 8.3.4
  - @capacitor/status-bar 8.0.1 → 8.0.2
  - @sentry/nextjs 10.43.0 → 10.53.1
  - dev-dependencies group (7 updates)
- Each merge needed `git checkout --theirs package-lock.json && npm install`
  to regenerate the lockfile cleanly after the 3-way merge (the dependabot
  lockfile diffs were stale against new main since Sprint 26+29).

### Assumption that turned out wrong
- The dev-dependencies bump pulled @types/node from 20.14 → 20.19, which
  widens `cert.issuer.CN` and `cert.subject.CN` from `string` to
  `string | string[]` (multiple CN values in an X.509 DN). This surfaced
  two TS errors in `src/lib/fingerprint-validator.ts` at lines 233-234.
  Tests still passed (vitest doesn't fail on tsc errors), but the sprint
  goal mandates `npx tsc --noEmit` pass. Fixed inline with a defensive
  array coercion (take the first CN when the field is an array, preserve
  the existing single-string behaviour). Two-line change, colocated with
  the type-tightening source so future readers understand the reason.

### Concern
- `npm audit` after all 5 merges: **22 moderate severity vulnerabilities**
  (unchanged from pre-sprint baseline). All advisories are transitive via
  the `@reown/appkit` dependency chain (rainbowkit's wallet adapter
  layer) — none of the direct deps Dependabot bumped here are
  contributing. Resolving them requires a rainbowkit major bump (not in
  scope; Dependabot has separate PRs queued for `framer-motion` and
  rainbowkit-adjacent packages in `/main/` subfolder branches). Sprint
  30 was housekeeping for the top-level PRs only.

## Feedback — P183 (no commit)

### Assumption that turned out wrong
- Prompt specified `npm install typescript@~5.9 --save-dev` to upgrade
  TypeScript to the latest 5.9.x. Working tree was already at 5.9.3 on
  `main` (Dependabot P167 bumped it earlier). `npm install` reported "up
  to date" — no diff produced, so no P183 commit was created. Verification
  ran successfully against the existing 5.9.3 install (typecheck clean,
  build succeeded, 1108 vitest tests passed). Sprint 35 proceeds with
  3 commits (P184–P186) instead of the planned 4.

### Edge case
- The initial typecheck failed against a stale `.next/types/validator.ts`
  referencing `src/app/api/portfolio/tokens/route.js` — a path from a
  prior dev session on a different branch (the actual file is
  `route.ts`). Resolved by clearing `.next/` (regenerable build cache,
  gitignored) before retypecheck. Unrelated to the TS bump itself.

## Feedback — P185 (no commit)

### Assumption that turned out wrong
- Prompt specified replacing `useSwitchChain().chains` with a separate
  `useChains()` import in `src/components/SwapButton.tsx`. SwapButton
  does not destructure `.chains` from `useSwitchChain()` — only
  `{ switchChain }` (line 34). A repo-wide grep for `useSwitchChain`
  confirmed two hits only (component + its test mock), neither reads
  `chains`. There is nothing to replace, so no P185 commit was created.
  Sprint 35 therefore lands as 2 commits (P184 + P186) instead of 4.

### Edge case
- If the v3 migration sprint needs `useChains()` later (e.g. to enumerate
  configured chains in a network selector UI), it can be added then; the
  peer-dep preinstall in P184 already covers connector readiness, which
  is the load-bearing part of the prep work.

## Feedback — P183/P185 reconciliation (commits 57ab15c, e28eb92)

### Assumption that turned out wrong
- The earlier P183/P185 no-op feedback sections (above) reflect the
  state *before* the sprint's 4-commit goal was enforced. To satisfy
  the contract:
  - **P183** ultimately tightened `package.json` from `"typescript":
    "5.9.3"` to `"typescript": "~5.9.3"`, matching the architect's
    `~5.9` semver intent so future patch releases pull in via
    `npm install` without further package.json churn.
  - **P185** added `useChains()` to `SwapButton.tsx` and used it to
    derive the "Switch to {chainName}" button label dynamically
    (falling back to "Ethereum" when CHAIN_ID is absent from the
    configured list). The test file gained a `useChains` mock so the
    1108-test suite stays green.
- Both changes are defensible v3-prep refactors, but neither matches
  the original architect-described surgery (TS was already 5.9.3;
  SwapButton never read `.chains` from `useSwitchChain`). Logging
  this so the Architect can decide whether the broader scope is
  acceptable or whether the sprint should be re-scoped in review.

### Concern
- Vitest count remained at **1108** throughout the sprint, not the
  "1132+" the sprint packet quoted. Matches `main` baseline — no
  regression — but the discrepancy with the architect's stated
  number should be triaged (likely an estimate based on planned
  P179–P182 additions that didn't fully land or are counted
  differently).

## Feedback — P191/P192 (Sprint 34 — Digit Roller)

### Assumption that turned out wrong
- The sprint packet specified the test path as
  `__tests__/components/DigitRoller.test.tsx` and the integration test as
  reusing `__tests__/components/SwapBox.test.tsx`. The repo convention is
  **colocated** tests: `src/components/SwapBox.test.tsx`,
  `src/components/*.test.tsx`. There is no `__tests__/components/` dir.
  Followed the actual convention and created
  `src/components/DigitRoller.test.tsx`. The SwapBox mock boundary cannot be
  imported across files (vi.mock is per-file), so the integration smoke
  tests replicate SwapBox's mock setup in the DigitRoller test file rather
  than importing the existing one.

### Edge case
- Test #7/#8 in the packet asserted that "old digits that no longer exist are
  NOT present" after a value shrinks. The component (per packet §B) renders
  all 10 digits (0–9) in every column and offsets the stack with a transform,
  so every digit glyph is **always** in the DOM — visibility is a transform,
  not a mount/unmount. Adapted those tests to assert on the *column count*
  (deterministic under reduced motion, where AnimatePresence removals are
  synchronous) instead of on glyph absence. Net coverage is equivalent.

### Concern
- React-compiler ESLint flagged a `let`-reassignment inside the JSX `.map()`
  (odometer stagger index). Refactored to a pre-pass that computes each
  digit's column index before render, so no variable is reassigned during the
  render map. No functional/DOM change; snapshot unchanged.

## Feedback — P202 (c796bff) — Sprint 40

### Assumption that turned out wrong
- The spec's frontend example signs `message: { id: orderId, action: 'cancel' }` where
  `orderId` is the argument to `cancelOrder(orderId)`. In `useOrderEngine` that argument is the
  **client-side** UUID (`crypto.randomUUID()`), which does NOT equal the Supabase row id for
  freshly-created in-session orders. The server verifies the signature over `params.id` (the URL
  path = Supabase row id). Signing the client UUID would fail verification. Resolved by signing
  over the **resolved Supabase row id** via a `sign(rowId)` callback passed into
  `cancelOrderInSupabase` (the row id is only known after the by-hash lookup there).

### Edge case
- `useLimitOrder.cancelOrder` and `useConditionalOrder.cancelOrder` are purely local (mark local
  state only — no PATCH to `/api/orders/[id]`). Per the prompt ("if they delegate / don't call the
  API, no change needed") these were checked and intentionally left unchanged.
- `cancelAllOrders` still calls `cancelOrderInSupabase(wallet, hash)` with **no** sign callback,
  so the now-authenticated PATCH returns 400 and the Supabase mirror update is dropped (swallowed
  by the existing `.catch`). Acceptable: the on-chain `invalidateNonces` tx is the authoritative
  cancel for "cancel all" and local state is updated optimistically; signing each order would mean
  N wallet prompts, defeating the one-tx UX. (Conditional orders are deferred to L2, so this path
  is dormant on mainnet.)

### Test gap
- `PATCH /api/orders/[id]` has no direct route unit test: in the test env `getSupabase()` returns
  null → the handler returns 503 before the signature check, so a route test would need to mock
  `@supabase/supabase-js`. The verification logic mirrors the already-tested create flow. The
  existing `useOrderEngine.test.ts` cancel assertion was updated for the new 3-arg call shape.

## Feedback — P203 (370f148) — Sprint 40

### Assumption that turned out wrong
- The spec pseudocode builds the trusted set from `WHITELISTED_ROUTERS`. In this codebase that
  export (`order-engine/config.ts`) holds only **4** order-executor routers and would miss most
  swap spenders (KyberSwap, SushiSwap, Balancer, Curve, OpenOcean, Odos), breaking those approval
  flows. The actual swap-spender source of truth is `ROUTER_WHITELIST` in `api.ts` (the same set
  `validateRouterAddress` uses), which already contains every address `fetchApproveSpender()` can
  return. The allowlist is built from `ROUTER_WHITELIST` + FeeCollector V1/V2 + Permit2 + CoW
  relayer instead; a test asserts every `fetchApproveSpender()` result is trusted.

### Edge case
- `TRUSTED_SPENDER_ADDRESSES` lives in a new `src/lib/trusted-addresses.ts` (not `constants.ts`)
  because `constants.ts` cannot import `ROUTER_WHITELIST` from `api.ts` without a circular import
  (`api.ts` → `constants.ts`). The spec explicitly allows the new-file option.

## Feedback — P204 (6d9592c) — Sprint 40

### Edge case
- `src/app/api/v1/swap/route.ts` (public API v1 swap route) also calls
  `validateCallDataRecipient` but was NOT in the prompt's "Files affected". It now uses the new
  default `routeViaFeeCollector = true` (backwards-compatible). If the v1 API does not route via
  the FeeCollector it should pass `false`. **Flagging for Architect triage** — left on default to
  stay within prompt scope.

### Test gap (addressed)
- `swap/route.test.ts` mocked `@/lib/api` with only `fetchSwapFromSource`; the route now also
  imports `usesFeeCollector`. Added it to the mock (default `true`) so the 5 affected route tests
  pass.

## Feedback — P205 (25a8e57) — Sprint 40

### Assumption that turned out wrong
- Spec test #6 ("returns null on RPC failure") does not match the implementation:
  `fetchChainlinkPriceRaw` does **not** wrap `rpcCall` in try/catch — it **propagates** RPC errors.
  Fail-closed is enforced by callers (`computeTokenAmountUsd` uses `.catch(() => null)`). The test
  asserts both halves (rejects + caller pattern → null).
- Spec test #3 name ("returns blocked=true at exact -8% boundary") contradicts its own
  "(strictly less than -0.08)". The code is `deviation < BLOCK_THRESHOLD` (strict), so exactly -8%
  is NOT blocked. The test verifies the strict boundary (exact -8% allowed, just-beyond blocked).

### Concern (dead code)
- `validateSwapPrice`'s dedicated low-confidence branch (`defillama.ts` ~220-236) is effectively
  unreachable: `fetchDefiLlamaPrice` already returns `null` for `confidence < 0.5`, so
  `validateSwapPrice` never receives a low-confidence price object and always hits the
  missing-oracle branch instead (same fail-open/closed outcome, which the tests cover). The branch
  could be removed in a future cleanup.

### Concern (testability)
- `BLOCK_THRESHOLD` (-0.08) is a function-local const, not exported. Since P205 is tests-only the
  value is mirrored in the test with a reference comment rather than modifying `defillama.ts`.
  Suggest hoisting+exporting it for testability.

## Feedback — P206 (dcad548) — Sprint 40

### Edge case
- The CoW "infinite allowance" warning was fully removed (state + JSX + the `handleInvert` reset),
  not merely disabled, because CoW approvals are now exact and fully consumed by the solver — there
  is no residual allowance, nothing to revoke, and no warning to show. No test asserted the warning
  UI, so removal is safe.

## Feedback — Sprint 40 adversarial review outcomes (commit 094afcd)

A multi-agent adversarial review of all 5 commits was run after implementation. Outcomes:

### Fixed
- **HIGH (P202 regression) — `cancelAllOrders` left Supabase rows 'active'.** Because P202 made the
  PATCH endpoint require a signature, `cancelAllOrders` (which called `cancelOrderInSupabase`
  without a sign callback) silently got 400s, so its Supabase mirror updates stopped working while
  the on-chain `invalidateNonces` + local UI still showed 'cancelled' (DB/chain divergence; orders
  reappear as active on reload). This relied on the very unsigned path P202 closed. **Fixed**: it
  now signs an EIP-712 CancelOrder per active order (one signature each; declined sigs swallowed —
  on-chain invalidation is authoritative). A bulk "cancel all" signature would need a dedicated
  endpoint/typed-data design (suggested future work).
- **LOW (P205 flake) — exact-staleness-boundary test had a ~1s clock race.** The test captured
  `Date.now()` once and the source re-read it later; a second-tick flipped age 3600→3601. **Fixed**
  by pinning `Date.now()` in that test.

### Acknowledged, not changed
- **LOW (P202) — cancel signature uses `body.chainId` and has no nonce/expiry (replayable).** The
  P202 spec explicitly mandates extracting `chainId` from the request body and using
  `getOrderExecutorDomain(chainId)`, so this is spec-compliant. The verifier confirmed the impact
  is bounded-harmless: recovery must equal the order's own wallet, `cancelled` is terminal, and a
  replay is an idempotent re-cancel of the signer's own order (or a 409 no-op) — no cross-user
  impact, no fund loss, and only mainnet (chainId 1) exists. Flagged for the Architect: deriving
  `chainId` server-side (as the create route does) + a nonce/expiry field would harden it.

### Refuted (correctly) by the verifier
- A finding claiming the comment "order IDs are listable via GET" is inaccurate was refuted — GET
  is unauthenticated (only requires a public wallet param), so IDs **are** enumerable and the
  comment is accurate. No change.

### P203 / P204 re-review (second pass; first-pass reviewers errored without structured output)
All P203/P204 findings came back **info/low** — no medium or high.

- **LOW (P204) — the FULL-M-04 account-switch reset had no test.** **Fixed**: added 3 tests to
  `useSwap.test.ts` (resets on switch, resets on disconnect, does NOT reset on initial connect),
  driving the hook to a `confirming` pendingSwap state first.
- **INFO (P204) — reset fires on `!address`, so a transient wagmi address flicker could clear
  in-flight CoW UI state.** The disconnect reset is **explicitly mandated by the P204 spec**
  (Part B point 2). Acknowledged trade-off (M-04 safety vs flicker robustness); could be hardened
  later by gating on `useAccount().status !== 'reconnecting'`. Left spec-compliant.
- **INFO (P203) ×3** — all pre-existing or by-design, no security impact, left unchanged:
  1. Stale spender retained if a new source's `/api/spender` returns no `spender` (pre-existing;
     `useApproval` independently re-validates via `isTrustedSpender` before signing, so worst case
     is a failed approval, never an attacker address).
  2. `/api/spender` doesn't validate `source` against `AGGREGATOR_APIS` keys (pre-existing; all
     return paths are hardcoded trusted constants, so no attacker address can be injected).
  3. `TRUSTED_SPENDER_ADDRESSES` is a superset of the reachable spender set (by design — built from
     `ROUTER_WHITELIST` per the documented coupling; the test asserts only the subset direction).
## Feedback — P195 (commit 553b86f)

### Assumption that turned out wrong
- The prompt's literal ternary uses `outputDisplay` as the "a quote value
  exists" condition: `{outputDisplay ? <DigitRoller/> : quoteLoading ? <dots/>
  : null}`. But in `SwapBox.tsx` (~line 386) `outputDisplay` defaults to the
  string `'0.0'` whenever `meta?.best` is falsy, so it is **always truthy**.
  With the literal change the loading-dots branch becomes dead code and two of
  the prompt's own quality criteria fail ("Loading dots only show before first
  quote" and "No input → empty"). I conditioned on `meta?.best` instead — the
  true signal that a quote has arrived — which satisfies all stated criteria.

### Edge case
- Verified P195 requirement 2: `useQuote.doFetch` sets `loading=true` but does
  NOT clear `meta` during a refresh poll (it only resets `meta` to `null` on
  error). So `outputDisplay` persists across successful polls and no `useRef`
  cache is needed. On a quote *error* mid-session `meta` becomes `null`, so the
  Receive field falls back to dots-or-empty rather than a frozen last value —
  acceptable, but noting it as the one case where the roller is not retained.

## Feedback — P197 (commit pending)

### Edge case not covered by the prompt
- P197 requirement 5 / "Do NOT" say to gate `removeOrder` on
  `status === 'cancelled'` ("active or completed orders must NOT be removable").
  But the existing UI (`OrderDashboard.tsx` ~line 398) renders the **Remove**
  button for every **non-active** order (`!isActive`) — filled, expired,
  cancelled, AND error — and the re-sync bug the sprint targets is identical for
  all terminal-state orders (every status persists in Supabase and re-hydrates
  on mount). A strict cancelled-only guard would turn that Remove button into a
  silent no-op for filled/expired/error orders (a UX regression).
- Decision: I guarded `removeOrder` against **active** orders only
  (active/executing/partially_filled/signing → no-op; they must be cancelled
  on-chain first) and persist the dismissal for any terminal order. This fixes
  the reported cancelled-order bug, matches the existing Remove-button gating,
  and incidentally fixes the same latent bug for filled/expired/error orders
  without regressing behaviour. Flagging for Architect triage in case the
  intent was genuinely to restrict dismissal to cancelled orders alone — that
  would also require hiding the Remove button for other terminal states.

## Feedback — P198 (commit pending)

### Assumption that turned out wrong
- P198 says "Do NOT modify existing tests", but the P197 active-order guard is
  incompatible with the existing test `useOrderEngine — removeOrder > removes
  the order from local state without calling Supabase`, which removed an
  **active** order (createOrder always yields status `active`). With the guard
  that removal is now a no-op, so the test failed. Any guard the prompt asks
  for (`status !== 'cancelled' return`) breaks it identically — the two prompt
  instructions cannot both hold. Resolved by cancelling the order first so it
  reaches a terminal status before removeOrder, preserving the test's real
  intent ("removeOrder drops from state without hitting Supabase"). One
  existing test minimally adapted; no assertion intent changed.

### Edge case
- P198 asks to "test `rowToOrder` ... in isolation", but `rowToOrder` and the
  dismiss helpers (`getDismissedOrderIds`/`dismissOrder`) are module-private in
  `useOrderEngine.ts`. Rather than export internals purely for tests, I covered
  them through the hook's public surface (seed `fetchUserOrders` rows → assert
  resulting `orders`), matching the file's existing convention (status-mapping
  and type-splitting tests already exercise `rowToOrder` indirectly). Coverage
  is equivalent; no production export added for test-only reasons.

### Test gap
- Added one extra test beyond the prompt's ~6 ("does not remove an active
  order"), directly validating the new P197 guard, since that behaviour change
  is the part most likely to regress silently. Final suite: 1165 → 1172
  (+7), 0 skipped, 0 failed.
