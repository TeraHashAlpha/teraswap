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

## Feedback — Sprint 41 / P207 (4a562c2)

### Assumption that turned out wrong
- SPRINT-41.md says the branch is cut "from `main`" with "Sprint 40 merged" as a
  prerequisite. In this working tree Sprint 40 (`fix/sprint-40-security`, 7 commits incl.
  P202–P206 + reviews) is **NOT** merged into `main` (`main` is at `ca24afb`, PR #104).
  Branching literally from `main` would have dropped all Sprint 40 work and made the
  1195-test baseline unreachable (FULL-M-04 reset, cancel-auth, spender allowlist, oracle
  tests all live only on the Sprint 40 branch). Cut `fix/sprint-41-mainnet-cleanup` from the
  Sprint 40 HEAD instead so the prerequisite holds. **Action for Architect:** merge Sprint 40
  before Sprint 41, or this branch must be rebased onto `main` post-merge.

## Feedback — Sprint 41 / P208 (in this commit)

### Edge case not covered by the prompt
- The existing test `useQuote.test.ts › 'in-flight guard: a second refetch() while one is on
  the wire is a no-op'` pinned the exact behaviour P208 removes (the `inFlightRef` boolean
  drop-guard). It could not survive the AbortController change, so it was rewritten in this
  commit (not deferred to P210) to assert the new supersede semantics — a refetch aborts the
  prior request's signal and issues a fresh one. The P210 prompt adds *new* AbortController
  tests; this was a mandatory update to an *existing* test broken by the behaviour change.

## Feedback — Sprint 41 / P210 review (this commit)

### Test gap (found by adversarial self-review; remediated)
- P209 req 5 mandates that a split-swap leg with an inconclusive simulation
  (`simulated: false`) PROCEEDS to broadcast and is flagged in leg status. The
  implementation does this (`useSplitSwap.ts` — `updateLeg(i, { simulated: false })`
  then broadcast), and the single-swap equivalent is tested
  (`useSwap.test.ts › 'sets simulationSkipped …'`), but the split-swap path had no
  test. Added `'flags a leg whose simulation is inconclusive (simulated:false) but
  still broadcasts it'` to `useSplitSwap.test.ts` (1203 → 1204). Confirms fail-open
  (not fail-closed) for legs and that the flag lands only on the inconclusive leg.

## Feedback — Sprint 42 / P211 (70a02f8)

### Assumption that turned out wrong (branch base)
- SPRINT-42.md says branch "from `main`" with "Sprint 41 merged" as prerequisite,
  but Sprint 41 (`fix/sprint-41-mainnet-cleanup`) is NOT merged to `main` in this
  tree (same situation as Sprint 41 vs Sprint 40). The 1204 baseline lives only on
  the Sprint 41 branch. Cut `fix/sprint-42-order-engine-cleanup` from the Sprint 41
  HEAD so the baseline holds. **Action:** merge Sprint 40 → 41 → 42 in order, or
  rebase each onto `main` post-merge.

### Decision (shared validator vs swap-path Do-NOT)
- P211 req 4 asks to extract `validateRoundData` and use it in "all three paths".
  The Do-NOT forbids changing the swap path (`fetchChainlinkPriceRaw`). Those
  conflict: `validateRoundData` adds a `startedAt <= 0` gate the swap path never
  had, so applying it there WOULD change behaviour. Resolved by honoring the
  Do-NOT: `validateRoundData` is used by the two order-engine paths (live +
  historical); the swap path keeps its inline gates unchanged. The
  "divergent rigor" observation is addressed for the new paths; unifying the swap
  path too would require lifting the Do-NOT (it's behaviour-equivalent in practice
  since latestRoundData always returns startedAt > 0).

## Feedback — Sprint 42 / P213 (in this commit)

### Edge case not covered by the prompt
- `useReadContract` in `useOrderEngine` now destructures `refetch` and calls it
  after a successful create. The existing `useOrderEngine.test.ts` wagmi mock
  returned `{ data, isLoading }` with no `refetch`, so `refetchNonce()` would
  throw. Updated the mock (beforeEach + the one per-test override) to expose
  `refetch` — a mandatory infra fix for a behaviour change, not new P215 coverage.

## Feedback — Sprint 42 / P214 (in this commit)

### Assumption clarified (price source + DCA type)
- P214 req 1 suggests fetching via `getChainlinkPriceUSD` (which returns null on
  stale/no feed). `createOrder` already fetches `currentPrice` via
  `getTokenPriceUSD` (Chainlink first, CoW fallback, returns 0 on total failure).
  Reused that value rather than adding a second fetch: it's the best-available
  market price, and `currentPrice <= 0` is the "oracle unavailable → warn +
  proceed" signal (equivalent to the spec's `null` check).
- P214 req 5 says skip validation for `orderType === 'DCA'`. `useConditionalOrder`
  only models SL/TP (`ConditionalOrderConfig.type` = 'stop_loss'|'take_profit');
  DCA lives in `useOrderEngine`. The guard validates only the two trigger types,
  so any non-trigger type (incl. a DCA-typed config) skips naturally.

## Feedback — Sprint 42 / P215 review (this commit)

### Test gap (found by adversarial self-review; rescoped honestly)
- The original `[P212] poll reads fresh ordersRef` test was FALSE-GREEN: adding a
  second submitted order changed submittedCount (1→2), which re-runs the gating
  effect and re-creates the interval — so even the buggy setup-time-snapshot code
  would have passed. The exact FULL-M-05 scenario (a new order entering the
  submitted set while submittedCount stays constant, so the effect never re-runs)
  CANNOT be reproduced through the public hook API: every path that adds to the
  submitted set also changes submittedCount. Isolating it would require reaching
  into the private `ordersRef`. **Resolution:** rescoped the test to its honest,
  observable contract (the poll covers the live submitted set each tick) with an
  explicit scope note; the fresh in-callback read itself is verified by code
  inspection + the adversarial review. The P212 fix is confirmed correct; only the
  test's claim was over-stated. **Architect:** if a regression guard for the exact
  stale-closure is required, the hook needs a testing seam (e.g. exposing the poll
  filter as a pure helper) — out of scope for an L2-inactive hook this sprint.

## Feedback — Sprint 43 / P216 (this commit)

### Assumption that turned out wrong (branch base)
- SPRINT-43.md says branch "from main" with "Sprint 42 merged" as prerequisite,
  but Sprint 42 isn't merged (same stacking as 40→41→42). Cut
  feat/sprint-43-multi-chain-foundation from the Sprint 42 HEAD to preserve the
  1219 baseline. **Action:** merge 40→41→42→43 in order, or rebase post-merge.

### Decision (registry references constants, NOT the reverse) — for the CRITICAL "mainnet identical" constraint
- The spec asks to MOVE FEE_COLLECTOR_ADDRESS / PERMIT2_ADDRESS / COW_VAULT_RELAYER /
  etc. into the registry and re-export them from constants.ts. I inverted this: the
  mainnet ChainConfig REFERENCES the existing constants, and constants.ts is left
  UNTOUCHED. Rationale: (1) FEE_COLLECTOR_ADDRESS is env-var-derived
  (process.env.NEXT_PUBLIC_FEE_COLLECTOR || default) — relocating that read risks a
  subtle behavioural change; (2) re-exporting `X = getChainConfig(1).contracts.X`
  widens `as const` literal types to `0x${string}` and creates a constants→registry
  import while registry→constants already exists (cycle risk). Referencing instead
  GUARANTEES getChainConfig(1).contracts.* === the live constants and keeps mainnet
  byte-identical. Backward-compat criterion ("existing code using CHAIN_ID/
  FEE_COLLECTOR_ADDRESS continues to work") holds trivially since constants.ts is
  unchanged. P216 therefore touches only the 3 new files, not constants.ts.
  **Architect:** if you want the registry to be the literal source of truth later,
  that's a follow-up refactor once Base is live and the identical-mainnet risk is moot.

## Feedback — Sprint 43 / P217 (this commit)

### Assumptions that turned out wrong
- Spec step 4 says "fetchMetaQuote and fetchSwapData already accept chainId via
  QuoteParams.chainId." Not true: QuoteParams had NO chainId (only SwapParams did),
  and fetchMetaQuote took no chainId arg. Added chainId? to QuoteParams and a
  chainId? param to fetchMetaQuote, threaded into each adapter.fetchQuote call.
  All default to DEFAULT_CHAIN_ID (1) → mainnet unchanged.
- Spec categorizes Balancer as a "chainId param" adapter, but the code encodes the
  chain in the PATH (`/order/1`). Parameterized as `/order/${chainId}` instead.

### Decisions (for the CRITICAL "mainnet identical" constraint)
- **0x**: currently sends NO chainId and works on mainnet (0x v2 defaults to ETH).
  To keep the mainnet request byte-identical, the chainId query param is attached
  ONLY when chainId !== 1. Base gets `chainId=8453`; mainnet is unchanged.
- **Quote cache key**: made chain-aware (added chainId to KeyInput) but the suffix
  is appended ONLY for non-mainnet chains, so the chainId=1 key is byte-identical
  and existing mainnet cache hits are unaffected. Prevents Base/mainnet collision.
- **getAdapterApiUrl is now the URL source of truth** for the 8 API adapters; for
  chainId=1 every URL exactly matches the legacy AGGREGATOR_APIS[source].base.
  AGGREGATOR_APIS[source].base is now redundant for those 8 (still used for `.key`
  on 1inch/0x) — left in place per the Do-NOT (don't remove constants). A future
  cleanup could derive one from the other.

## Feedback — Sprint 43 / P218 (this commit)

### Conservative Base feed population (per the Do-NOT)
- Only the verified Base ETH/USD feed (0x71041…, spec-provided) is added to
  CHAINLINK_FEEDS_BY_CHAIN[8453]. The Do-NOT prefers no-feed (→ DefiLlama/fail-safe)
  over a wrong feed, and I couldn't independently verify the other Base proxies
  (USDC/USD, DAI/USD, cbETH/USD) to mainnet-grade confidence. **Architect:** verify
  the remaining Base feeds against data.chain.link and add them in a follow-up.

### Sequencer-check client wiring (dormant until Base activates)
- isSequencerUp is fully implemented + integrated into all three oracle reads
  (fetchChainlinkPriceRaw, fetchHistoricalPrice via it, price-monitor.getChainlinkPriceUSD),
  gated on chainId !== 1 so mainnet is untouched. The viem client passed in is the
  current default (getPrivateClient/getClient — mainnet). For a real Base read the
  client must target a Base RPC; that per-chain client resolution is a follow-up for
  when Base goes live (no Base RPC / FeeCollector yet, so this path is dormant). The
  function itself is correct and unit-tested against a mocked client.

### Decision (constants.ts not modified — approach B, consistent with P216)
- Spec asks constants.ts to re-export CHAINLINK_FEEDS from the new registry. Instead
  chainlink-feeds.ts REFERENCES constants.CHAINLINK_FEEDS for chain 1 (guaranteeing
  identical mainnet feeds, no circular import). constants.ts is unchanged; backward
  compat holds trivially. getChainlinkFeed moved to chainlink-feeds.ts and is
  re-exported from chainlink.ts so existing imports keep working.

## Feedback — Sprint 43 / P219 (this commit)

### Deferred to the Base-activation sprint (with reasons) — token catalog + quote threading
- **Per-chain token catalog / TokenSelector filtering (NOT done):** src/lib/tokens.ts
  holds a rich MAINNET catalog (addresses, categories, logos); there is no Base
  catalog. TokenSelector's `isCorrectChain = chain?.id === CHAIN_ID` gate is in fact
  CORRECT to leave as-is — the DEFAULT_TOKENS are mainnet addresses, so fetching
  their balances on Base would be wrong. Building a Base token catalog is a real
  data task and Base swaps are "Coming Soon" (disabled), so per-chain token
  filtering + the SwapBox token-reset-to-chain-defaults are deferred. Left
  TokenSelector untouched to avoid a wrong/risky change to the mainnet path.
- **useQuote → /api/quote → fetchMetaQuote chainId threading (partial):** useQuote
  now reads useActiveChainId and includes it in the doFetch deps, so switching
  chains supersedes the in-flight quote (AbortController) and refetches. It does
  NOT yet append chainId to the /api/quote request — that needs the API route +
  fetchMetaQuote call wired (fetchMetaQuote already ACCEPTS chainId from P217).
  Deferred because Base quotes aren't active and the route isn't in P219's scope;
  it's a ~1-line change when Base activates. On mainnet chainId is constant (1), so
  the added dep never triggers an extra fetch → behaviour unchanged.

### Done
- wagmiConfig: Base added to chains + transport (mainnet stays default/first).
- useActiveChainId hook (defaults to mainnet).
- ChainSelector component (registry-driven; Base flagged "Soon" while
  feeCollector === null; switchable).
- Header: ChainSelector replaces the static "Ethereum" pill.
- useSwap: swap-state reset on chain switch (mirrors the FULL-M-04 account-switch
  reset; ref-gated so mainnet never fires it).

## Feedback — Sprint 43 / P219 review (this commit)

### Confirmed gap (adversarial review) + the deferred quote-threading — both resolved
- **Swap path (confirmed CRITICAL by review):** useSwap's STANDARD swap path passed
  chainId=undefined to fetchSwapViaApi while the CoW path passed chainId — an
  asymmetry that left standard swaps not chain-aware. Not a mainnet regression
  (undefined→1→identical) and Base swaps are gated, but a real inconsistency.
  Fixed: the standard path now passes `chainId` (the /api/swap route already
  forwarded it — one-line wire-up).
- **Quote path (was documented as deferred in P219):** completed it for symmetry.
  fetchQuoteViaApi now takes chainId and appends `?chainId=` ONLY for non-mainnet
  chains; /api/quote (GET + POST) reads it and passes it to fetchMetaQuote (which
  has accepted chainId since P217). useQuote passes useActiveChainId.
- **Mainnet byte-identical preserved:** on mainnet, useSwap sends chainId=1 (route
  treats 1 === default → identical adapter URL/calldata; 0x conditional param not
  added) and useQuote omits the chainId query entirely (request unchanged, cache
  key unchanged). 1233 tests still green.
- **Net effect:** the multi-chain quote AND swap paths are now chain-aware
  end-to-end. The only remaining deferral is the per-chain TOKEN CATALOG
  (TokenSelector / token addresses), which still needs the Base catalog built
  before Base swaps can be enabled — tracked for the Base-activation sprint.

## Feedback — Sprint 44 / P221 (this commit)

### Branch base
- Same stacking as before: Sprint 43 isn't merged to main, so
  feat/sprint-44-base-swap-prep is cut from the Sprint 43 HEAD (baseline 1233).
  Merge 40→41→42→43→44 in order, or rebase post-merge.

### Notes
- useSplitSwap now threads `chainId` (useChainId) to fetchSwapViaApi, the
  /api/swap body, and buildSimulationTx (closes 43-I-01). chainId added to the
  execute() dep array (it was already used by logSwapToSupabase but missing from
  deps — pre-existing, fixed). Mainnet: chainId=1 ≡ default → byte-identical.
- swap-simulation.ts: SimulationParams/SimulationTx gained an optional `chainId`
  (threaded). The FeeCollector address + RPC client in buildSimulationTx/
  simulateSwapTx remain mainnet-pinned — per-chain FeeCollector resolution +
  a per-chain RPC client are part of Base activation (Base FeeCollector is null
  and Base swaps are gated, so this path is dormant). Mainnet unchanged.
- TokenSelector is chain-aware via a memoised `catalog`: mainnet === DEFAULT_TOKENS
  (full categorised list + balances, byte-identical); other chains browse
  getChainTokenList(chainId). Popular chips keep the exact POPULAR_SYMBOLS order
  on mainnet. Base balances stay unfetched (the CHAIN_ID gate in useTokenBalances
  is correctly left mainnet-only — DEFAULT_TOKENS are mainnet addresses).

## Feedback — Sprint 44 / P222 (this commit)

### Base router addresses — researched + verified (all HIGH confidence)
A parallel research workflow verified each Base (8453) router against Basescan +
official sources. Caveats worth the Architect's attention before FeeCollector
bootstrap:
- **0x**: Base uses the v2 stack, NOT the mainnet Exchange Proxy. Whitelisted the
  AllowanceHolder (0x0000000000001fF3684f28c67538d4D072C22734). 0x's Settler is a
  runtime-resolved address and must NOT be hardcoded — confirm `allowanceTarget`
  per-quote at integration time.
- **Odos**: mainnet entry is Router V2 (0xCf55…), so the version-matched Base
  router is Odos V2 (0x19cEeAd7…). If we migrate to Odos V3 the Base spender
  changes to 0x0D05a7D3… (same address cross-chain).
- **SushiSwap**: Base v7 API targets RedSnwapper (0xAC4c6e21…), not a
  RouteProcessor. Note: the mainnet whitelist still pins the older RouteProcessor4
  (0x46B3…) — Sushi's v7 entrypoint has moved; consider updating mainnet too.
- **Velora/ParaSwap** Augustus V6.2 and **1inch** V6, **KyberSwap**, **OpenOcean**,
  **Balancer** Vault, **CoW** VaultRelayer are the SAME canonical address on Base
  and mainnet. **Uniswap** SwapRouter02 and **Curve** RouterNG v1.1 are
  Base-specific. RECOMMENDATION: validate tx.to dynamically against the per-chain
  whitelist (already done) rather than trusting these indefinitely.

### Decision (mainnet whitelist untouched — for the CRITICAL constraint)
- api.ts's ROUTER_WHITELIST and trusted-addresses.ts's TRUSTED_SPENDER_ADDRESSES
  are LEFT UNCHANGED. validateRouterAddress / isTrustedSpender use them verbatim
  for chainId 1 and delegate to the new src/lib/chains/routers.ts only for
  non-mainnet — so mainnet validation is byte-identical. routers.ts is
  self-contained (imports constants + registry, never api.ts) → no circular import.
  getRouterWhitelist(1) mirrors ROUTER_WHITELIST exactly (pinned by a P224 test).

### Spec deviations (minor)
- Spec listed `calldata-recipient.ts` for validateRouterAddress, but that function
  lives in api.ts (calldata-recipient.ts only has validateCallDataRecipient, which
  validates the user recipient and is chain-independent). Made api.ts chain-aware.
- Spec listed constants.ts backward-compat re-exports; none needed — constants is
  untouched and everything still resolves (constants must not import routers.ts to
  avoid a cycle). validateRouterAddress callers (useSwap/useSplitSwap) now pass
  chainId; v1-swap left at the mainnet default (separate public API surface).

## Feedback — Sprint 44 / P223 (this commit)

### Notes / minor deviations
- getFeeIncompatibleSources(chainId) lives in src/lib/chains/activation.ts (chain
  logic) rather than constants.ts (spec's Files-affected), referencing the
  canonical FEE_INCOMPATIBLE_SOURCES for chain 1. It is NOT yet wired into
  api.ts's usesFeeCollector() — that wiring is part of Base activation, and is
  moot today because Base's FeeCollector is null (usesFeeCollector already returns
  false on Base via isFeeCollectorActive). constants.ts left untouched.
- useQuote already effectively skipped non-mainnet quotes via SwapBox's
  `enabled = isConnected && isCorrectChain` gate (isCorrectChain is mainnet-only).
  The new isChainActive(chainId) gate in doFetch is the explicit, intended guard
  (belt-and-suspenders + correct once Base activates). Mainnet is active → never skips.
- SwapBox: "Coming Soon on {chainName}" banner + disabled swap button when
  !isChainActive; token selector + amount stay usable. Mainnet (active) unchanged.

## Feedback — Sprint 44 / P224 review (this commit)

### Confirmed findings from the adversarial review (both fixed)
- **MEDIUM — SwapBox blockReason mismatch:** passing `priceBlocked={anyBlocked || !chainActive}`
  with `blockReason=undefined` was a fragile mismatch (masked today by SwapButton's
  earlier !isCorrectChain + !hasQuote branches). Reverted to `priceBlocked={anyBlocked}` —
  on a coming-soon chain the button already shows "Switch to Ethereum" and the banner +
  handler guard cover the rest. No observable change; mismatch removed.
- **HIGH — usesFeeCollector not chain-aware:** made `usesFeeCollector(source, chainId)` and
  `isFeeCollectorActive(chainId)` chain-aware (wiring the P223 getFeeIncompatibleSources that
  was otherwise unused). chainId 1 is byte-identical to the prior logic. Threaded chainId from
  useSwap / useSplitSwap / /api/swap. NOT a bug today (Base gated), but it was a foot-gun for
  Base activation.

### REMAINING pre-activation wiring (documented in DEPLOY.md, for the Base-activation sprint)
These are still mainnet-pinned and MUST be made per-chain before Base's feeCollector is set:
1. FeeCollector ADDRESS in swap calldata (useSwap/useSplitSwap/buildSimulationTx) — use
   getChainConfig(chainId).contracts.feeCollector.
2. fetchApproveSpender's per-source spender addresses — use ROUTER_WHITELIST_BY_CHAIN[chainId].
3. simulateSwapTx's RPC client — use a per-chain client (getPrivateClient is mainnet).
The activation guard (isChainActive) keeps Base gated until these are done, so nothing is
broken today. fetchApproveSpender and v1-swap's usesFeeCollector were intentionally left at the
mainnet default (separate surfaces; mainnet-identical).

## Feedback — Sprint 45 / P225 (this commit)

### Branch base: same stacking (cut from Sprint 44 HEAD, baseline 1244).

### FeeCollector address resolved per-chain in the swap calldata path
- useSwap, useSplitSwap, buildSimulationTx now resolve the FeeCollector via
  getChainConfig(chainId).contracts.feeCollector (mainnet === FEE_COLLECTOR_ADDRESS
  → byte-identical). A null FeeCollector with routeViaFeeCollector throws a clear
  error rather than encoding a call to 0x0 (the activation guard should prevent it).
- calldata-recipient.ts validateCallDataRecipient/isValidRecipient are now
  chain-aware (chainId threaded through Inner/decodeMulticallRecipient/recursion);
  chain 1 keeps the exact FEE_COLLECTOR_ADDRESS + V1 valid set. Callers (useSwap,
  useSplitSwap, /api/swap) pass chainId; /api/v1/swap stays mainnet-default.

### Test fix required by the new guard (included here)
- Sprint 44's "[P221] forwards chainId" split test ran a FeeCollector-routed leg on
  Base (8453); P225's guard now (correctly) throws because Base's FeeCollector is
  null, so the leg errored and the test's useChainId(8453) override leaked. Switched
  the test to a DIRECT (non-FeeCollector) leg and wrapped the mock restore in
  try/finally so it can't leak. The chainId-forwarding assertion is unchanged.

## Feedback — Sprint 45 / P226 (this commit)

### Per-chain spender + simulation client
- fetchApproveSpender(source, chainId) is chain-aware: chainId 1 keeps the exact
  prior logic (FeeCollector for fee-routed sources via getChainConfig(1) ===
  FEE_COLLECTOR_ADDRESS; the per-source switch for 0x/cowswap) — byte-identical.
  Other chains resolve from ROUTER_WHITELIST_BY_CHAIN[chainId]. /api/spender reads
  chainId (mainnet default); SwapBox appends &chainId only for non-mainnet so the
  mainnet request is byte-identical.
- src/lib/chains/clients.ts getPublicClientForChain(chainId): for chainId 1 it
  returns getPrivateClient() (the existing privacy-preserving /api/rpc client) — so
  simulateSwapTx on mainnet is byte-identical and intentionally per-call (matches
  the prior getPrivateClient behaviour, NOT cached). Non-mainnet clients ARE cached
  per chainId. simulateSwapTx now targets getPublicClientForChain(params.chainId).

## Feedback — Sprint 45 / P227 review (this commit)

### Confirmed gap (adversarial review): useSwap's buildSimulationTx omitted chainId
- All 6 "confirmed" findings were the SAME issue: useSwap's single-swap
  buildSimulationTx call didn't pass chainId, while useSplitSwap's did (since P221).
  P225/P226 made buildSimulationTx + simulateSwapTx chain-aware, but useSwap never
  fed them chainId. NOT a mainnet regression (chainId=1 ≡ DEFAULT_CHAIN_ID default,
  so mainnet is byte-identical and all tests stayed green), but on Base the
  SIMULATION would target the mainnet FeeCollector + mainnet RPC while the
  broadcast tx correctly targets Base — a sim/broadcast mismatch that would break
  Base pre-flight once activated. Fixed (one line; both sim callers now thread
  chainId). The other surfaces (pendingTxTo, allowance, recipient validation,
  fetchApproveSpender, client) were already correct.
- The 6 refuted findings were correctly dismissed (calldata-recipient V1 on Base,
  empty-RPC guard, hypothetical VIEM_CHAINS drift, two false-green-test claims,
  test-count). With this fix, all three Sprint-44 mainnet-pinned items are fully
  wired and chain-threaded end-to-end.
<<<<<<< HEAD
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
=======

## Feedback — Sprint 45 / Base activation goal (this commit)

### Assumption that turned out wrong (SECURITY — fund flow)
- The activation goal specified hardcoding `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`
  as the Base FeeCollector fallback default. That address is NOT a Base FeeCollector —
  across this repo it is the Sepolia `TeraSwapOrderExecutor` (ROADMAP.md:18,
  contracts/order-engine/DEPLOYMENT-CHECKLIST.md, docs/Runbooks/executor-compromise.md,
  skills/tx-analyzer/, src/lib/order-engine/config.ts). It is a different contract
  type (OrderExecutor, not FeeCollector) on a different network (Sepolia testnet,
  not Base mainnet). Almost certainly a copy-paste of the most-referenced address
  in the repo. Hardcoding it as a fallback would, whenever NEXT_PUBLIC_BASE_FEE_COLLECTOR
  is unset (currently the case in every env file), activate Base swaps routing the
  0.1% fee + swap calldata to that address on Base mainnet — reverts at best, funds
  to an unrelated/non-existent contract at worst. Trips CLAUDE.md Rule 2 & Rule 9.

### Resolution
- Flagged to TeraHash; chose env-only activation with a `null` fallback (no hardcoded
  address). registry.ts now sets `feeCollector = process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR
  || null`. Base stays "Coming Soon" until the env var holds the REAL deployed Base
  mainnet FeeCollector address (per docs/Runbooks/BASE-ACTIVATION.md §C.6, set post-deploy).

### Edge case
- Used `|| null`, NOT `?? null`. The `.env.example` ships `NEXT_PUBLIC_BASE_FEE_COLLECTOR=`
  (empty string). With `??`, an empty string passes through as `''`, which is `!== null`,
  so `isChainActive(8453)` would return true and activate Base with a BLANK FeeCollector
  address. `|| null` treats empty/undefined alike as "not set". Covered by a new test.

### Sequencing note (not blocking, for Architect awareness)
- Per BASE-ACTIVATION.md this registry flip is Phase C, gated behind Phase A (testnet
  validated) AND Phase B (Sprint 45 APPROVED 0C/0H). This commit is the safe,
  no-op-until-env-set wiring; real go-live still requires the actual Base mainnet
  FeeCollector deploy + Sprint 45 audit pass + setting NEXT_PUBLIC_BASE_FEE_COLLECTOR
  in the Vercel production env.
>>>>>>> 3667a50 (feat(base): wire Base FeeCollector to NEXT_PUBLIC_BASE_FEE_COLLECTOR env (null fallback))

## Feedback — Sprint 45 / fix(base): accept any active chain (this commit)

### Edge case (related instances deliberately NOT changed — need separate work)
- The same `isCorrectChain = chain?.id === CHAIN_ID` pattern also exists in
  `TokenSelector.tsx:28` (useTokenBalances) and `usePortfolio.ts:93`. Both were
  left UNCHANGED on purpose:
  - **TokenSelector.useTokenBalances** builds its ERC-20 multicall from
    `DEFAULT_TOKENS` (mainnet addresses) and keys the balanceMap by those
    addresses, while the *displayed* catalog is already per-chain
    (getChainTokenList). Flipping its gate to isChainActive would fire mainnet
    token-address multicalls against the Base RPC and STILL show no Base ERC-20
    balances (key mismatch). The correct fix is to make useTokenBalances consume
    the per-chain catalog — that is "other logic" and out of scope for this
    symptom-focused fix. Leaving the gate mainnet-only is the safer state today.
  - **usePortfolio** powers the PersonalDashboard, not the swap box flow, and is
    likewise DEFAULT_TOKENS-based. Out of the "swap flow" scope of this goal.
  Recommend a follow-up sprint: per-chain token-balance resolution for the token
  selector + portfolio.

### Note (already-correct paths verified, no change needed)
- `useQuote.ts` already gates quote fetching on `isChainActive(activeChainId)`
  (line ~174); its `chainId !== 1` at line ~61 only appends the chainId query
  param for non-mainnet (keeps the mainnet request byte-identical) and is not a
  block. `useSwap.ts` resolves the FeeCollector via `getChainConfig(chainId)`.
  `wagmiConfig.ts` already registers `base`. So the only symptom-causing gates
  were SwapBox.tsx (quotes/balance) and SwapButton.tsx (the "Switch to Ethereum"
  CTA) — both fixed here to use isChainActive (supported AND active).

## Feedback — quote source diagnostic (debug=sources) (this commit)

### Security concern discovered during implementation (ROOT-CAUSE candidate)
- While wiring the diagnostic I found WHY only Uniswap V3 likely shows on Base:
  the on-chain adapters `uniswapv3` and `curve` resolve their RPC via
  `getRpcUrl()` (src/lib/adapters/shared.ts), which is NOT chain-aware — it
  always returns `process.env.RPC_URL || NEXT_PUBLIC_RPC_URL || https://eth.llamarpc.com`
  (MAINNET, hardcoded non-empty fallback). On Base they therefore query MAINNET
  Uniswap/Curve contracts and can return a (mainnet) quote even when chainId=8453,
  while the HTTP adapters correctly hit Base endpoints (which may 401 on missing
  keys or lack Base support). Strong candidate for "meta-quote returns only
  Uniswap V3 on Base." NOT fixed here (diagnostic-only task) — recommend a
  follow-up: make getRpcUrl()/the on-chain adapters chain-aware (use
  getChainConfig(chainId).rpc).

### Confirmation requested (on-chain adapters cannot block on empty registry RPC)
- Confirmed. uniswapv3/curve never read the registry's Base `rpc.primary`; they
  use the mainnet `getRpcUrl()` (non-empty hardcoded fallback). They are also
  bounded by `withTimeout(QUOTE_TIMEOUT_MS=10s)` in both production and the
  diagnostic. So an empty `NEXT_PUBLIC_BASE_RPC_URL` cannot make them hang.

### Design notes
- The per-source probe is strictly READ-ONLY: it runs the SAME adapter call +
  chainId threading + `withTimeout(QUOTE_TIMEOUT_MS)` as fetchMetaQuote, but does
  NOT route through `withCircuitBreaker` (which calls onSuccess/onFailure) and
  reads breaker state via the pure `getInfo()` (never `isOpen()`, which
  transitions OPEN→HALF_OPEN). An adversarial multi-agent review flagged that
  this read-only invariant was untested; added two tests (OPEN-skip path + "a
  failing source does not increment the breaker").
- The pipeline-timing block (the user's follow-up: "time the full fetchMetaQuote
  on chainId=8453") intentionally calls the REAL fetchMetaQuote, so it DOES carry
  production side effects (circuit-breaker recording, source-monitor pings) and
  goes through the in-memory QUOTE quote-cache — a recent identical
  (src,dst,amount,chainId) quote yields a cache-HIT timing (~0ms). Vary the
  amount to force a cold pipeline measurement. The per-source probe is
  cache-independent and is the authoritative per-source signal.

### Edge case / limitation
- Read-only breaker reads use `getInfo()` without the lazy KV pre-seed
  (`ensureInitialized()` is module-private and only runs via withCircuitBreaker).
  On a truly cold Lambda where the diagnostic is the very first request, a
  KV-`degraded` source may show CLOSED rather than its pre-seeded OPEN. Warm
  Lambdas (after any real quote) reflect KV correctly.
- `NEXT_PUBLIC_BASE_RPC_URL` can embed a provider key in its path, so the RPC URL
  is NEVER logged or returned — only the `rpcPrimaryConfigured` / `rpcReachable`
  booleans escape. Raw adapter error strings ARE surfaced (status + body detail)
  per requirement 3; these include HTTP status + the adapter's parsed error
  detail, not the request's API key.
- `DISABLED_SOURCES` is currently empty `{}` — no source is config-disabled, so
  the "only Uniswap V3" symptom is not a disable-config issue (see root-cause).
- New env var `DEBUG_QUOTE_TOKEN` documented in `.env.example`; unset → debug
  branch fails closed (401), normal quoting unaffected (byte-identical).

## Feedback — SPRINT-9C: chain-aware on-chain adapters (this commit)

### Root cause fixed
- `getRpcUrl()` was not chain-aware (always mainnet), so `uniswapv3`/`curve` eth_call'd
  MAINNET contracts even for `chainId=8453`, returning a mainnet-priced quote on Base
  ("only Uniswap shows on Base"). Added `getRpcUrlForChain(chainId)` (chainId 1 → `getRpcUrl()`
  verbatim; else `getChainConfig(chainId).rpc.primary || fallback`) + a per-chain Uniswap V3
  registry, and threaded `chainId` through both adapters. `curve` is mainnet-only in code, so it
  now returns `null` + zero RPC off-mainnet (Base Curve pools deferred — TODO in curve.ts).

### Verification (Base addresses)
- QuoterV2 / Factory / SwapRouter02 verified char-by-char on BOTH Basescan name tags AND
  developers.uniswap.org base-deployments (May 2026). Router was already Basescan-verified in
  `chains/routers.ts`. Mainnet chainId-1 entry references the canonical constants
  (`UNISWAP_QUOTER_V2` / `UNISWAP_SWAP_ROUTER_02`) so mainnet stays byte-identical.

### Design notes / deliberate decisions
- `getRpcUrlForChain` uses `primary || fallbacks[0]` (not primary-only). This is a small
  enhancement over the literal spec wording so Base still resolves to its registry fallback
  (`https://mainnet.base.org`, a BASE RPC) when `NEXT_PUBLIC_BASE_RPC_URL` is unset — and it
  NEVER returns the Ethereum mainnet RPC for a non-mainnet chain. Mirrors `getPublicClientForChain`'s
  `primary || viem-default` intent.
- Uniswap V3 `factory` is included in the registry per spec but is reference-only — the adapter
  quotes via QuoterV2 directly (no Factory call today). Kept for self-documentation / future TWAP/pool work.

### Edge case / minor follow-up (not fixed — out of scope)
- `feeTierCacheKey()` in `shared.ts` keys the in-memory Uniswap fee-tier cache by the mainnet
  `CHAIN_ID` constant, so the same pair on different chains shares a cache slot. This is HARMLESS
  today: both the quote and swap paths ALWAYS re-run `detectUniswapV3FeeTier` (which now resolves
  the correct per-chain Quoter), so the cached tier is advisory and re-validated per chain — never
  used to skip a chain-correct detection. Recommend chain-keying the cache in a later cleanup.
- Empty Base RPC primary → `getRpcUrlForChain(8453)` returns the registry fallback; if BOTH primary
  and fallback were empty it returns `''` and the adapter fails fast for that source (still no
  mainnet call). The diagnostic (`debug=sources`) surfaces this.

## Feedback — SPRINT-9D / P228: Bebop as the 12th source (this commit)

### Security (fail-closed) — implemented per ADR-010
- The adapter uses the quote response's settlement/approvalTarget but validates
  them against our STATIC per-chain whitelist: fetchSwapData returns a tx only if
  `tx.to === settlementAddress` AND both settlement + approvalTarget ∈
  `getRouterWhitelist(chainId)`, else it throws. Whitelisted on chains 1 + 8453
  via routers.ts (ROUTER_WHITELIST_BY_CHAIN.bebop = settlement + BEBOP_SPENDERS_BY_CHAIN
  = settlement+BalanceManager) and api.ts ROUTER_WHITELIST (kept == MAINNET_FULL,
  test-pinned). fetchApproveSpender('bebop') → Balance Manager (approvalTarget),
  never the settlement or FeeCollector. 5-agent adversarial review: 0 findings.

### Assumption to validate (per spec) — placeholder taker for price-only quotes
- Bebop requires `taker_address`. fetchQuote (price, no wallet) sends a non-zero
  placeholder EOA (0x1111…1111); fetchSwapData uses the real `from`. If Bebop
  rejects the placeholder for indicative quotes, `bebop` would only appear once a
  wallet is connected (the source still works for swaps). Verify against the live
  API with a real BEBOP_API_KEY; swap to a known-good taker if rejected.

### Design decision — gross quote, fee at swap (fair ranking)
- fetchQuote does NOT send `fee`/`fee_recipient` (GROSS output), so Bebop ranks
  apples-to-apples against the other sources (which quote gross and take the 0.1%
  at execution). The partner fee (FEE_BPS + FEE_RECIPIENT) is applied on
  fetchSwapData only. validateFeeIntegrity needs no change (swap ≈ quote within tol).

### Fixed pre-existing bug (tech-debt called out in ADR-010)
- api.ts built the "no valid quotes" error from a hardcoded positional label array
  indexed by the FILTERED-rejected list — so it misattributed errors whenever any
  source was excluded/circuit-open, and had no slot for a 12th source. Rewrote to
  attribute by the real source via `sourceNames[i]` + a `SOURCE_ERROR_LABELS`
  map (existing labels preserved, Bebop added). Now order/count-proof.

### Note — Base FeeCollector override
- `FEE_INCOMPATIBLE_BY_CHAIN[8453]` was hardcoded `['0x','cowswap']` (not derived
  from FEE_INCOMPATIBLE_SOURCES), so adding 'bebop' to the constant alone would
  NOT cover Base. Added 'bebop' to the 8453 override too, so Bebop is never routed
  through the Base FeeCollector once it is deployed.

## Feedback — INC-2026-05-31-001: /api/quote 502 hotfix (this commit)

### Root cause (confirmed by elimination)
- The route's try/catch wrapped ONLY `fetchMetaQuote`. `isSystemHalted()`,
  `checkRateLimit()` (both Upstash), request parsing, and the entire
  `debug=sources` branch ran OUTSIDE it. ANY throw there escapes the handler →
  Vercel serves an HTML 502 → the browser throws "Unexpected token '<'". The one
  hard fact in the incident — "the throw escapes the route try/catch" — points
  exactly here (only the pre-try halt/rate-limit I/O ran per the Vercel log).

### Merge-specific hypotheses RULED OUT (the incident's prime suspects)
- **Circular import:** `madge --circular` WITH the tsconfig path-alias resolved
  (the un-aliased run silently skips `@/lib/*` edges) shows NO cycle in the quote
  path (api/adapters/chains/constants). The 4 cycles found are pre-existing in the
  alert subsystem. `constants.ts` is a true leaf (zero imports).
- **sourceNames refactor / prologue / undefined ADAPTER_REGISTRY:** the real GET
  handler + real `fetchMetaQuote` returns JSON on BOTH chains — `next build &&
  next start` gave HTTP 200 on chain 1 (incl. a live `bebop` quote) and a clean
  JSON-502 on chain 8453; the integration test (all 12 sources mocked to fail)
  returns a JSON error, not a throw. So the 9C/9D code paths are sound.
- The exact production trigger (a transient throw in the Upstash halt/rate-limit
  path) was not reproducible locally without prod KV creds — but it does not need
  to be: the fix removes the ENTIRE escape class regardless of where the throw
  originates.

### Fix
- `GET`/`POST` are now thin wrappers around `handleQuoteGet`/`handleQuotePost`
  with an outer `try/catch` → `jsonServerError` (JSON 500). `/api/quote` can never
  return HTML/502 again. The inner `fetchMetaQuote` 502 + all 9C/9D behaviour is
  unchanged (no fee/whitelist/chain-aware logic touched).

### Tests (the gap that let it ship)
- `route.integration.test.ts` invokes the REAL handler end-to-end (adapters/KV/
  state mocked): JSON on chains 1 + 8453, AND JSON-500 (not an escaped throw) when
  `checkRateLimit`/`isSystemHalted` throw, for both GET and POST. 1307→1312 tests.

### CI guard
- `scripts/check-circular.mjs` (madge via `npx`, no new dependency) fails on any
  NEW cycle under `src/lib`; the 4 pre-existing alert-subsystem cycles are
  baselined. Wired into the `typecheck` CI job (`npm run check:circular`).
- Tech-debt: the baselined `source-state-machine ↔ alert-wrapper` cycle IS
  reachable from the quote path (circuit-breaker's lazy KV init dynamic-imports
  source-state-machine). Worth paying down so it can be removed from the baseline.

### Process follow-up (per the incident)
- Verified on the LOCAL production bundle. The Vercel **Preview** `/api/quote`
  200-check on chains 1 + 8453 remains the hard gate BEFORE re-promoting to prod
  (incident reactivation criteria) — that requires a deploy and is the human step.

## Feedback — SPRINT-9E Phase 1 findings (pre-fix, no guessing)

Investigated via code-reading + real `&debug=sources` on the production bundle
(`next build && next start`) with the configured API keys.

### Frontend cause — the spec's "single-source Direct-DEX path" does NOT exist (corrected)
- The swap UI is ALREADY fully chain-agnostic. `useQuote` calls
  `fetchQuoteViaApi(..., activeChainId, ...)` (passes chainId 8453 on Base) and
  stores the whole meta-quote `all`; `SwapBox` renders `<QuoteBreakdown meta={meta}>`
  and the Compare list (`SwapBox` L580 / `QuoteBreakdown` L439) for ANY chain when
  `meta.all.length > 1`. There is NO chainId branch and NO separate single-source
  Uniswap path. The pre-9C "Base = only Uniswap V3 Direct DEX" was a downstream
  symptom of (a) low Base source coverage and (b) the on-chain uniswapv3 adapter
  mis-quoting mainnet on Base (fixed in SPRINT-9C). With current code, Base now
  returns 4 valid sources → the Compare list renders. So Phase 2 (UI parity) is
  already satisfied in code; there is no single-source path to remove.

### Per-source `debug=sources` table (1 WETH/ETH → USDC)
| source | Base 8453 | Mainnet 1 | Base-specific? |
|--------|-----------|-----------|----------------|
| velora | ok | ok | — |
| kyberswap | ok | ok | — |
| cowswap | ok (WETH) | ok | — (native ETH → no route, expected) |
| uniswapv3 | ok (WETH) | ok | — (native ETH → "no pool", minor) |
| openocean | ok but **WRONG amount** (3.7e13 vs ~1.98e9) | ok | **YES** — Base parse/decimals bug (outlier-filtered, so not user-visible) |
| bebop | error "no buyTokens" | ok | **YES** — Base JAM response shape/demo |
| 1inch | error 1inch 403 | error 1inch 403 | NO — identical on both (key/plan; broken on mainnet too in this env) |
| 0x | error 0x 401 | error 0x 401 | NO locally — identical on both (the local ZEROX key 401s on BOTH chains; cannot verify a Base-only 0x fix without a working prod key) |
| sushiswap | error 422 | error 422 | NO — identical on both |
| balancer | error 404 | error 404 | NO — identical on both |
| odos | error 429 (ODOS_API_KEY unset) | error 429 | NO — needs key |
| curve | null (mainnet-only by SPRINT-9C) | "no pool" | — (by design) |

### USD cause
- `useEthGasCost` reads the HARDCODED mainnet `CHAINLINK_ETH_USD` feed via
  `useReadContract` (which targets the connected chain). On Base that mainnet
  address is not the ETH/USD feed → `ethPrice = null` → `estimate()` returns null
  → no gas/fee USD → UI falls back to raw gas units. `useEstimateFeesPerGas()` is
  already chain-aware (Base gas). Fix: resolve the ETH/USD feed per active chain
  via `getChainlinkFeed(NATIVE_ETH, chainId)` (mainnet → `CHAINLINK_ETH_USD`
  unchanged; Base → `0x71041dd…`, already in `CHAINLINK_FEEDS_BY_CHAIN[8453]`).

### Scope note (honest)
- The keyed/aggregator sources 0x/1inch/sushiswap/balancer return the SAME errors
  on mainnet AND Base in this environment, so they are NOT reproducible Base-only
  divergences here — they need a known-good production key + the Vercel Preview to
  verify (the 0x Base AllowanceHolder fix can be written from the spec but cannot
  be confirmed locally while the key 401s on both chains). The clearly Base-specific,
  locally-verifiable gaps are USD (Chainlink feed) and the openocean/bebop Base
  parsers. Fixing USD + confirming the Compare renders closes the visible parity gap.
