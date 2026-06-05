# Sprint 9C — M-01 Phase 2: Frontend Integration Test Expansion

**Sprint window:** 2026-05-25 → TBD  
**Sprint goal:** Expand frontend integration test coverage from 86 tests (7 files, Sprint 16A P115) to ~220+ tests covering all Tier 1 (money-movement) and Tier 2 (order/analytics) hooks and components. Every prompt = 1 atomic commit.  
**Owner:** TeraHash (founder/architect) + code agent  
**Prerequisite:** Latest `main` branch with Sprint 27C merged.  
**Branch:** Create `test/m01-phase2` from `main`.

**IMPORTANT:** This is a test-only sprint. Do NOT modify any production source files in `src/hooks/`, `src/components/`, `src/lib/`, `src/app/api/`, or contracts. Only create new `.test.ts` / `.test.tsx` files and, if needed, extend test-utils.

> **Architect notes (2026-05-25):**
>
> 1. **Reuse existing test infrastructure.** `src/test-utils/setup.ts` (jest-dom + localStorage polyfill), `render.tsx` (renderWithProviders + ToastProvider), and `mock-wagmi.ts` (makeWagmiMocks factory) are already wired. Every new test file should import from these — do NOT create parallel utilities.
>
> 2. **Mock at the boundary, not internals.** P115 established the pattern: mock `wagmi` hooks, `fetch` / API modules, and `@/lib/*` modules. Never mock React internals (`useState`, `useEffect`). Never use snapshot tests.
>
> 3. **localStorage hooks need the polyfill.** `useLimitOrder`, `useConditionalOrder`, and `useOrderEngine` all read/write localStorage on mount. The polyfill in `setup.ts` handles this, but each test must clear storage in `beforeEach` to avoid cross-test bleed: `localStorage.clear()`.
>
> 4. **`useOrderEngine` is 588 lines with obfuscation.** The XOR obfuscation (`obfuscate`/`deobfuscate`) and migration from plain JSON are internal. Test the hook's public API (createOrder, cancelOrder, orders list), not the storage format. But DO test that orders survive a "remount" (unmount + mount again) to verify persistence.
>
> 5. **EIP-712 signing mocks.** Three hooks call `signTypedDataAsync`. Use `makeWagmiMocks()` which already stubs `useSignTypedData`. The mock's `signTypedDataAsync` should resolve to a fake signature `'0xdeadbeef...'` (64 hex chars). Test both success and user-rejection (throw with `name: 'UserRejectedRequestError'`).
>
> 6. **Supabase mocks for useOrderEngine.** Mock the entire `@/lib/order-engine` module. The hook imports `createOrderInSupabase`, `fetchUserOrders`, `fetchActiveOrders`, `cancelOrderInSupabase`, `subscribeToOrders`. Stub them all. `subscribeToOrders` should return `{ unsubscribe: vi.fn() }`.
>
> 7. **`calculateAutoSlippage` is a pure function export from SlippageModal.** Test it directly (no render needed) — it's the most valuable unit test in that file.
>
> 8. **Component tests need `// @vitest-environment jsdom` at the top.** Hook-only tests can run in the default `node` environment if they don't touch DOM. But any test using `renderWithProviders` or `@testing-library/react` MUST declare jsdom.

---

## Sprint status table

| # | Prompt | Description | Status |
|---|--------|------------|--------|
| 79 | Split swap hook tests | useSplitSwap + useSplitRoute — fee validation, calldata checks, leg execution | ✅ DONE (`43c7550`) |
| 80 | Limit + conditional order hook tests | useLimitOrder + useConditionalOrder — EIP-712, polling, localStorage, triggers | ✅ DONE (`79eb28d`) |
| 81 | Order engine hook tests | useOrderEngine — Supabase, nonce, obfuscation, cancel, hash computation | ✅ DONE (`f317743`) |
| 82 | Core swap component tests | SwapBox + TokenSelector + SlippageModal — orchestration, balance display, auto-slippage | ✅ DONE (`90848f9`) |
| 83 | Order + quote component tests + utilities | QuoteBreakdown + LimitOrderPanel + OrderDashboard + useDebounce + useEthGasCost | ✅ DONE (`a2f451e`) |

---

## Prompt 79 — Split swap hook tests

**Status:** Pending

**Closes:** M-01 Phase 2 (partial — split swap layer)

**Context:** `useSplitSwap` (343 lines) handles multi-leg swap execution through the FeeCollector. It validates calldata selectors, recipient addresses, fee integrity, and router whitelist for each leg independently. `useSplitRoute` (159 lines) analyzes whether splitting a trade across multiple DEXes improves output. Both are completely untested — any regression in fee validation or calldata checks would go undetected.

**Objective:** Create integration tests for `useSplitSwap` and `useSplitRoute` covering all security-critical paths and edge cases.

**Requirements:**

**File: `src/hooks/useSplitSwap.test.ts`**

1. Mock dependencies before import:
   - `wagmi`: via `makeWagmiMocks()` — needs `useAccount`, `useChainId`, `useSendTransaction`, `useSignTypedData`
   - `@/lib/api`: mock `validateFeeIntegrity`, `validateRouterAddress`, `usesFeeCollector`, `submitCowOrder`, `pollCowOrderStatus`
   - `@/lib/rpc`: mock `getPrivateClient` returning `{ getTransactionReceipt: vi.fn() }`
   - `@/lib/analytics`: mock `logSwapToSupabase`, `updateSwapStatus`
   - `@/lib/calldata-recipient`: mock `validateCallDataRecipient`
   - `@/lib/swap-selectors`: export real `KNOWN_SWAP_SELECTORS` (needed for validation logic)

2. Create fixtures:
   - `mockSplitRoute`: a `SplitRoute` with `isSplit: true`, 2 legs (60%/40% split), sources `['1inch', 'paraswap']`
   - `mockQuoteResponse`: a `NormalizedQuote` with valid `tx.to`, `tx.data` (prefixed with a known swap selector), `toAmount`
   - Helper `fetchReturns(quote)` that makes the internal `fetchSwapViaApi` (via fetch mock) return the quote

3. Test cases for `useSplitSwap`:
   - **idle state**: returns `status: 'idle'`, empty legs, null error on mount
   - **guard: no tokens**: calling `execute()` without tokenIn/tokenOut does nothing (status stays idle)
   - **guard: no address**: when `useAccount` returns disconnected, execute does nothing
   - **happy path (2 legs, both FeeCollector)**: `usesFeeCollector` returns true for both → verifies `validateFeeIntegrity` called twice, `validateRouterAddress` called twice, `validateCallDataRecipient` called twice, final status is `'success'`, `completedLegs === 2`
   - **leg amount split**: verify per-leg amounts are `(totalRaw * BigInt(percent)) / 100n` — use a known input amount and check the fetch call arguments
   - **calldata too short**: mock fetch returning `tx.data` with < 10 chars → status `'error'`, error message mentions calldata
   - **calldata too large**: mock fetch returning `tx.data` with > 200k chars → status `'error'`
   - **unknown selector**: mock fetch returning `tx.data` starting with `'0xdeadbeef'` (not in KNOWN_SWAP_SELECTORS) → status `'error'`
   - **recipient validation fail**: `validateCallDataRecipient` throws → status `'error'` for that leg
   - **fee integrity fail**: `validateFeeIntegrity` returns false → status `'error'` for that leg
   - **router whitelist fail**: `validateRouterAddress` returns false → status `'error'` for that leg
   - **partial success**: first leg succeeds, second leg fails → status `'partial'`, `completedLegs === 1`
   - **user rejection**: `sendTransaction` mock throws with `UserRejectedRequestError` → status `'error'`, error message indicates user cancelled
   - **receipt timeout**: `getTransactionReceipt` never resolves within timeout → appropriate handling
   - **receipt reverted**: receipt returns `status: 'reverted'` → leg marked as error
   - **reset()**: after error, calling `reset()` returns to idle state
   - **ETH path vs ERC-20 path**: when `tokenIn` is native ETH, verify `swapETHWithFee` selector used; when ERC-20, verify `swapTokenWithFee` selector
   - **safeBigInt guard [10-L-01]**: when `toAmount` is malformed/undefined, `legMinOutput` defaults to `0n`

**File: `src/hooks/useSplitRoute.test.ts`**

4. Mock dependencies:
   - `@/lib/split-router`: mock `fetchSplitQuotes`, `findBestSplit`
   - `@/lib/utils`: export real `safeBigInt`

5. Test cases for `useSplitRoute`:
   - **disabled**: when `enabled: false`, returns `splitResult: null`, `analyzing: false`
   - **below threshold**: when execution price USD < `SPLIT_MIN_USD`, does not fetch split quotes
   - **stablecoin output price detection**: when `tokenOut.symbol` is 'USDC', uses output amount directly as USD estimate
   - **split recommended**: when `findBestSplit` returns `isSplit: true` with `improvementBps >= SPLIT_MIN_IMPROVEMENT_BPS`, sets `splitRecommended: true` and auto-enables
   - **split not recommended**: when improvement < threshold, `splitRecommended: false`, `useSplit: false`
   - **toggleSplit**: calling `toggleSplit()` flips `useSplit` state
   - **stale request guard**: rapid re-renders with changing `amountIn` → only the latest result is used
   - **parseUnits failure**: invalid `amountIn` (e.g., 'abc') → does not crash, returns null result

**Do NOT:**
- Modify any source file outside of test files
- Use snapshot tests
- Mock React hooks (`useState`, `useEffect`, `useCallback`)
- Import from `@testing-library/react` in hook-only tests — use `renderHook` from `@testing-library/react` only if needed
- Hard-code line numbers in comments — use function/variable names

**Files affected:**
- `src/hooks/useSplitSwap.test.ts` (NEW)
- `src/hooks/useSplitRoute.test.ts` (NEW)

**Expected output:** 1 commit, ~25-30 new test cases across 2 files. All existing tests still pass.

**Quality criteria:**
- `npm test` passes (0 failures)
- `npx tsc --noEmit` passes (0 type errors)
- Every security validation in useSplitSwap has at least one test (fee integrity, router whitelist, calldata selector, calldata length, recipient)
- No test depends on another test's state (each is independent)

---

## Prompt 80 — Limit order + conditional order hook tests

**Status:** Pending

**Closes:** M-01 Phase 2 (partial — order hooks)

**Context:** `useLimitOrder` (261 lines) manages the full limit order lifecycle: EIP-712 signing via CoW Protocol, localStorage persistence, and status polling. `useConditionalOrder` (335 lines) extends this with automated price monitoring via Chainlink — when a price trigger fires, it auto-submits a CoW limit order. Neither hook has any tests. Both handle real user funds through signed orders.

**Objective:** Create integration tests for `useLimitOrder` and `useConditionalOrder` covering signing, persistence, polling, trigger logic, and error handling.

**Requirements:**

**File: `src/hooks/useLimitOrder.test.ts`**

1. Mock dependencies before import:
   - `wagmi`: via `makeWagmiMocks()` — needs `useAccount`, `useChainId`, `useSignTypedData`
   - `@/lib/limit-order-api`: mock `buildLimitOrderParams`, `submitLimitOrder`, `fetchLimitOrderStatus`
   - `@/lib/constants`: export real `COW_SETTLEMENT`

2. In `beforeEach`: `localStorage.clear()` + `vi.clearAllMocks()` + `vi.useFakeTimers()`
   In `afterEach`: `vi.useRealTimers()`

3. Test cases:
   - **initial state**: empty orders, no active/history, not submitting
   - **localStorage load**: pre-seed localStorage with `LIMIT_STORAGE_KEY` containing 2 serialized orders → hook returns them on mount
   - **localStorage parse failure**: seed localStorage with invalid JSON → hook returns empty array (no crash)
   - **createOrder happy path**: `buildLimitOrderParams` returns params, `signTypedDataAsync` resolves, `submitLimitOrder` resolves with orderId → order appears in `orders` with status `'open'`, `isSubmitting` transitions `false → true → false`
   - **createOrder user rejection**: `signTypedDataAsync` throws `UserRejectedRequestError` → order not added, `isSubmitting` returns to false, no error thrown to caller
   - **createOrder API failure**: `submitLimitOrder` rejects → order added with status `'error'`
   - **polling: fulfilled**: seed an open order, mock `fetchLimitOrderStatus` returning `'fulfilled'` → after advancing timers by `LIMIT_POLL_INTERVAL_MS`, order status updates to `'fulfilled'`, `latestEvent` fires
   - **polling: expired**: same pattern, status → `'expired'`
   - **polling: partiallyFilled**: status → `'partiallyFilled'`, order stays in `activeOrders`
   - **polling starts/stops**: with 0 open orders, `fetchLimitOrderStatus` is never called; add an open order, advance timer → called; order fills → stops calling
   - **cancelOrder**: marks order as `'cancelled'` locally, persists to localStorage
   - **removeOrder**: removes from list entirely, persists
   - **EIP-712 domain**: verify `signTypedDataAsync` is called with correct domain (`name: 'Gnosis Protocol'`, `version: 'v2'`, `verifyingContract: COW_SETTLEMENT`)
   - **receiver is always connected wallet**: verify the order struct passed to `submitLimitOrder` has `receiver === address` (from useAccount)
   - **persistence across remount**: create an order, unmount hook, remount → order still present (loaded from localStorage)

**File: `src/hooks/useConditionalOrder.test.ts`**

4. Mock dependencies before import:
   - Same wagmi mocks as above
   - `@/lib/limit-order-api`: same mocks
   - `@/lib/price-monitor`: mock `getTokenPriceUSD`, `isTriggerMet`
   - `@/lib/conditional-order-types`: export real constants `CONDITIONAL_STORAGE_KEY`, `PRICE_POLL_INTERVAL_MS`, `ORDER_POLL_INTERVAL_MS`

5. Test cases:
   - **initial state**: empty orders, no active/history
   - **createOrder**: stores order with status `'monitoring'`, persists to localStorage
   - **price monitoring loop**: seed a monitoring order, mock `getTokenPriceUSD` returning a price, `isTriggerMet` returning false → advance timer by `PRICE_POLL_INTERVAL_MS` → `getTokenPriceUSD` called with correct token address
   - **trigger fires**: `isTriggerMet` returns true → order transitions to `'triggered'`, then auto-signs + submits → `'submitted'`
   - **double-trigger prevention**: `isTriggerMet` returns true on two consecutive polls → `signTypedDataAsync` called only once (triggeringRef guard)
   - **trigger + user rejection**: trigger fires but user rejects signature → order status `'error'`
   - **submitted order polling**: order in `'submitted'` status → mock `fetchLimitOrderStatus` returning `'fulfilled'` → after `ORDER_POLL_INTERVAL_MS`, status → `'filled'`
   - **cancelOrder**: sets status to `'cancelled'`, stops monitoring
   - **removeOrder**: removes entirely
   - **multiple orders, different tokens**: 2 monitoring orders for different tokens → `getTokenPriceUSD` called for each unique token address
   - **localStorage persistence**: create order, unmount, remount → order still in `'monitoring'` state

**Do NOT:**
- Mock `setTimeout`/`setInterval` directly — use `vi.useFakeTimers()` + `vi.advanceTimersByTime()`
- Test internal `ordersRef` implementation — test the observable behavior (stale closure prevention is internal)
- Modify any production source files

**Files affected:**
- `src/hooks/useLimitOrder.test.ts` (NEW)
- `src/hooks/useConditionalOrder.test.ts` (NEW)

**Expected output:** 1 commit, ~28-32 new test cases across 2 files. All existing tests still pass.

**Quality criteria:**
- `npm test` passes (0 failures)
- `npx tsc --noEmit` passes (0 type errors)
- EIP-712 domain verified in at least one test per hook
- localStorage round-trip tested (write → unmount → remount → read)
- Fake timers properly restored in afterEach (no timer leaks)

---

## Prompt 81 — Order engine hook tests

**Status:** Pending

**Closes:** M-01 Phase 2 (partial — autonomous order engine)

**Context:** `useOrderEngine` (588 lines) is the most complex frontend hook. It manages autonomous orders (Limit, Stop-Loss, DCA) with on-chain signature verification via `OrderExecutorV2`, Supabase persistence + real-time subscriptions, localStorage obfuscation, nonce management, and order hash computation that must match the Solidity contract exactly. Zero test coverage.

**Objective:** Create comprehensive integration tests for `useOrderEngine` covering the full order lifecycle, security invariants, and edge cases.

**Requirements:**

**File: `src/hooks/useOrderEngine.test.ts`**

1. Mock dependencies before import:
   - `wagmi`: via `makeWagmiMocks()` — needs `useAccount`, `useChainId`, `useSignTypedData`, `useReadContract`, `useWriteContract`
   - `@/lib/order-engine`: mock ALL named exports — `createOrderInSupabase`, `fetchUserOrders`, `fetchActiveOrders`, `cancelOrderInSupabase`, `subscribeToOrders`, `ORDER_EXECUTOR_ABI`, `ORDER_EXECUTOR_ADDRESS`, `ORDER_EIP712_TYPES`, `OrderType`, `PriceCondition`, `ORDER_POLL_INTERVAL_MS`
   - `viem`: let `keccak256`, `encodeAbiParameters`, `toBytes` pass through (real implementations) — the hash computation must use real crypto

2. Create fixtures:
   - `mockOrderConfig`: a `CreateOrderConfig` with `orderType: OrderType.LIMIT`, valid token addresses, amounts, expiry, priceFeed, router
   - `mockOrderRow`: a Supabase `OrderRow` with all fields populated
   - `mockNonce`: `5n` (current nonce from contract)

3. Configure `useReadContract` mock to return different values based on `functionName`:
   - `'nonces'` → `mockNonce`
   - `'invalidatedNonces'` → `0n`

4. Configure `useWriteContract` mock: `writeContractAsync` as `vi.fn()` resolving to a fake tx hash

5. Configure `subscribeToOrders` to return `{ unsubscribe: vi.fn() }`

6. In `beforeEach`: `localStorage.clear()` + `vi.clearAllMocks()` + `vi.useFakeTimers()`

7. Test cases — **Lifecycle:**
   - **initial state**: `orders: []`, `isLoading: true` initially, then `false` after Supabase fetch resolves
   - **load from Supabase on mount**: `fetchUserOrders` returns 2 rows → `orders` has 2 entries with correct mapped statuses
   - **localStorage fallback**: Supabase fetch fails → falls back to localStorage orders (pre-seeded)
   - **createOrder happy path**: calls `signTypedDataAsync` with correct EIP-712 domain (`name: 'TeraSwapOrderExecutor'`, `version: '2'`, `verifyingContract: ORDER_EXECUTOR_ADDRESS`), then `createOrderInSupabase` with signature + order data → order appears in `orders` with status `'active'`
   - **createOrder user rejection**: `signTypedDataAsync` throws → `isSubmitting` returns to false, order not created
   - **cancelOrder**: calls `writeContractAsync` (on-chain cancel) + `cancelOrderInSupabase` → order status → `'cancelled'`
   - **cancelAllOrders**: calls `writeContractAsync` with `invalidateNonces` + bulk `cancelOrderInSupabase` → all active orders cancelled
   - **removeOrder**: removes from local state + localStorage, does NOT call Supabase

8. Test cases — **Filtering:**
   - **activeOrders**: only returns orders with status `'active' | 'executing' | 'partially_filled' | 'signing'`
   - **historyOrders**: only returns `'filled' | 'expired' | 'cancelled' | 'error'`
   - **limitOrders / stopLossOrders / dcaOrders**: filter by `orderType`

9. Test cases — **Security:**
   - **EIP-712 domain fields**: verify exact domain passed to `signTypedDataAsync`
   - **nonce from contract**: verify `createOrder` uses the nonce returned by `useReadContract('nonces')`, not a hardcoded value
   - **routerDataHash [C-01]**: verify the order struct includes `routerDataHash` field (not empty/zero)
   - **dcaTotal defaults to 1**: when config doesn't specify `dcaTotal`, verify it defaults to `1` (not `0`)

10. Test cases — **Persistence:**
    - **obfuscated localStorage**: after creating an order, read `localStorage.getItem('teraswap_orders_v3')` → value is NOT plain JSON (obfuscated)
    - **persistence round-trip**: create order → unmount → remount (with Supabase failing) → order loaded from localStorage
    - **migration from plain JSON**: seed localStorage with plain JSON array → hook reads it successfully (backward compat)

11. Test cases — **Polling:**
    - **active order polling**: with active orders, advance timers by `ORDER_POLL_INTERVAL_MS` → `fetchActiveOrders` called
    - **no polling when no active orders**: with only history orders, `fetchActiveOrders` never called after mount

12. Test cases — **Status mapping:**
    - **mapDbStatus**: verify `'executed'` → `'filled'`, `'failed'` → `'error'`, other statuses pass through

**Do NOT:**
- Test the internal `obfuscate`/`deobfuscate` functions directly — test via the hook's public API
- Test `computeOrderHash` in isolation (it's not exported) — verify indirectly through `signTypedDataAsync` call arguments
- Mock `viem` crypto functions — let them run real to catch hash mismatches
- Modify any production source files

**Files affected:**
- `src/hooks/useOrderEngine.test.ts` (NEW)

**Expected output:** 1 commit, ~25-28 new test cases in 1 file. All existing tests still pass.

**Quality criteria:**
- `npm test` passes (0 failures)
- `npx tsc --noEmit` passes (0 type errors)
- EIP-712 domain verified
- Nonce management verified (reads from contract, not hardcoded)
- localStorage round-trip tested (including migration from unobfuscated format)
- Supabase subscription cleanup verified (unsubscribe called on unmount)

---

## Prompt 82 — Core swap component tests

**Status:** Pending

**Closes:** M-01 Phase 2 (partial — swap UI components)

**Context:** `SwapBox` is the main swap form — it orchestrates `TokenSelector`, `QuoteBreakdown`, `SlippageModal`, `SwapButton`, `TransactionPreview`, and all swap hooks. `TokenSelector` renders token selection with live balances via multicall. `SlippageModal` exports `calculateAutoSlippage` (pure function) and renders the slippage settings UI. None have tests.

**Objective:** Create component integration tests for SwapBox, TokenSelector, and SlippageModal.

**Requirements:**

All component test files MUST start with `// @vitest-environment jsdom`.

**File: `src/components/SlippageModal.test.tsx`**

1. **`calculateAutoSlippage` unit tests** (no render needed — pure function):
   - Stable-to-stable (USDC → USDT) → `0.1`
   - Major-to-stable (ETH → USDC) → `0.3`
   - Stable-to-major (USDC → WETH) → `0.3`
   - Major-to-major (ETH → WBTC) → `0.5`
   - Memecoin involved (PEPE → ETH) → `2.0`
   - Unknown tokens (FOO → BAR) → `0.5` (default)
   - Undefined inputs → `0.5` (default)

2. **SlippageModal render tests** (use `renderWithProviders`):
   - Renders 4 preset buttons (0.1, 0.5, 1.0, 3.0)
   - Clicking a preset calls `onChange` with that value
   - Custom input: typing '2.5' calls `onChange(2.5)`
   - Auto mode: when `isAuto: true`, shows auto badge, input is disabled
   - Toggling auto calls `onAutoChange`
   - Close button calls `onClose`

**File: `src/components/TokenSelector.test.tsx`**

3. Mock dependencies:
   - `wagmi`: `useAccount`, `useBalance`, `useReadContracts` (for multicall balances)
   - `@/lib/tokens`: export real `TOKENS` array (or a subset fixture)
   - `react-dom`: let `createPortal` pass through
   - `@/components/TokenAddressBadge`: mock as simple div
   - `@/hooks/useTokenImport`: mock returning `{ importToken: vi.fn(), importing: false }`

4. Test cases:
   - Renders popular token chips (ETH, USDC, USDT, WBTC at minimum)
   - Clicking a popular chip calls `onSelect` with correct token
   - Search input filters tokens by symbol
   - Search input filters tokens by name (partial match)
   - Disabled token (matching `disabledAddress`) is not clickable
   - Shows formatted balance when wallet connected (mock `useBalance` + `useReadContracts`)
   - Shows no balance when wallet disconnected

**File: `src/components/SwapBox.test.tsx`**

5. Mock dependencies (this component has many):
   - All hooks: `useQuote`, `useSwap`, `useApproval`, `useChainlinkPrice`, `useSplitRoute`, `useSplitSwap`, `useSwapHistory`, `useActiveApprovals`, `useEthGasCost`
   - `wagmi`: `useAccount`, `useBalance`
   - Child components that are already tested: let `SwapButton`, `TransactionPreview`, `Permit2EducationModal` render as mocked divs with data-testid
   - `TokenSelector`, `QuoteBreakdown`, `SlippageModal`: mock as simple divs with data-testid
   - `@/lib/tokens`: export `findToken` returning fixture tokens
   - `@/lib/sounds`: mock all sound functions as `vi.fn()`

6. Test cases:
   - **renders without crash**: mounts with default state (ETH → USDC)
   - **token swap button**: clicking the swap/flip arrow swaps tokenIn ↔ tokenOut
   - **amount input**: typing an amount updates `displayAmountIn` and triggers `useQuote`
   - **slippage modal toggle**: clicking settings gear opens SlippageModal, clicking close hides it
   - **MEV protection toggle**: when `useQuote` returns a CoW-eligible route, MEV hint appears; dismissing persists to localStorage
   - **quote loading state**: when `useQuote` returns `loading: true`, shows skeleton
   - **error state**: when `useQuote` returns an error, displays error message
   - **wallet disconnected**: shows connect wallet prompt instead of swap button
   - **split route indicator**: when `useSplitRoute` returns `splitRecommended: true`, split UI is visible

**Do NOT:**
- Test SwapButton, TransactionPreview, or Permit2EducationModal behavior (already covered in P115)
- Import real child components that have complex dependencies — mock them
- Use snapshot tests
- Modify any production source files

**Files affected:**
- `src/components/SlippageModal.test.tsx` (NEW)
- `src/components/TokenSelector.test.tsx` (NEW)
- `src/components/SwapBox.test.tsx` (NEW)

**Expected output:** 1 commit, ~30-35 new test cases across 3 files. All existing tests still pass.

**Quality criteria:**
- `npm test` passes (0 failures)
- `npx tsc --noEmit` passes (0 type errors)
- `calculateAutoSlippage` has 100% branch coverage (all token category combinations)
- SwapBox renders without errors in all wallet states (connected, disconnected)
- No `act()` warnings in test output

---

## Prompt 83 — Order + quote components + utility hook tests

**Status:** Pending

**Closes:** M-01 Phase 2 (final — remaining Tier 1-2 coverage)

**Context:** `QuoteBreakdown` renders swap quote details (rates, fees, gas, slippage, source labels). `LimitOrderPanel` is the UI for creating limit orders via `useOrderEngine`. `OrderDashboard` displays order history with filters. `useDebounce` (13 lines) and `useEthGasCost` (50 lines) are utility hooks used across the app. All untested.

**Objective:** Create tests for the remaining Tier 1-2 components and utility hooks, completing M-01 Phase 2.

**Requirements:**

All component test files MUST start with `// @vitest-environment jsdom`.

**File: `src/hooks/useDebounce.test.ts`**

1. Use `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`.

2. Test cases:
   - Returns initial value immediately (before delay)
   - After `delayMs`, returns updated value
   - Rapid changes: only the last value is emitted after delay
   - Changing `delayMs` resets the timer
   - Returns the correct type (generic — test with string and number)

**File: `src/hooks/useEthGasCost.test.ts`**

3. Mock `wagmi`: `useReadContract`, `useEstimateFeesPerGas` via `makeWagmiMocks()`.

4. Configure `useReadContract` to return different values per call:
   - First call (`latestRoundData`): `[0n, 250000000000n, 0n, 1716000000n, 0n]` (ETH = $2500, 8 decimals)
   - Second call (`decimals`): `8`

5. Configure `useEstimateFeesPerGas`: `{ maxFeePerGas: 20_000_000_000n }` (20 gwei)

6. Test cases:
   - **ethPrice computed correctly**: `250000000000 / 10^8 = 2500`
   - **gasPriceGwei computed correctly**: `20_000_000_000 / 1e9 = 20`
   - **estimate function**: `estimate(200_000)` → `{ eth: 0.004, usd: 10.0 }` (200k gas × 20 gwei × $2500)
   - **null when data missing**: when `useReadContract` returns undefined, `ethPrice` is null, `estimate()` returns null
   - **null gas price**: when `useEstimateFeesPerGas` returns no `maxFeePerGas`, `gasPriceGwei` is null

**File: `src/components/QuoteBreakdown.test.tsx`**

7. Mock dependencies:
   - `@/lib/api`: export real types (`MetaQuoteResult`, `PriceCheck`), mock functions as needed
   - `@/lib/constants`: export real `FEE_BPS`, `FEE_PERCENT`, `FEE_NATIVE_SOURCES`
   - `@/lib/utils`: export real `safeBigInt`

8. Create fixture:
   - `mockMeta`: a `MetaQuoteResult` with `best: { source: '1inch', toAmount: '1000000000', estimatedGas: '200000', gasUsd: '10.00', routes: [] }`, `all: [best]`
   - `mockTokenIn`: ETH (18 decimals), `mockTokenOut`: USDC (6 decimals)

9. Test cases:
   - Renders exchange rate (tokenIn/tokenOut)
   - Shows source label (e.g., "1inch")
   - Shows fee when source uses FeeCollector (`FEE_NATIVE_SOURCES`)
   - Shows "No fee" when source doesn't use FeeCollector
   - Shows minimum output based on slippage
   - Shows gas estimate when `gasEstimate` prop provided
   - Countdown displays remaining seconds
   - `priceCheck` warning renders when deviation is high
   - Edit slippage button calls `onEditSlippage`
   - **safeBigInt guard [10-L-01]**: when `best.toAmount` is undefined/malformed, renders '0' output (no crash)

**File: `src/components/LimitOrderPanel.test.tsx`**

10. Mock dependencies:
    - `@/hooks/useOrderEngine`: mock returning `{ limitOrders: [], isSubmitting: false, createOrder: vi.fn(), cancelOrder: vi.fn(), cancelAllOrders: vi.fn(), removeOrder: vi.fn(), latestEvent: null }`
    - `wagmi`: `useAccount`, `useChainId`
    - `@rainbow-me/rainbowkit`: mock `useConnectModal` returning `{ openConnectModal: vi.fn() }`
    - `@/lib/price-monitor`: mock `fetchCurrentPrice`
    - `@/components/TokenSelector`: mock as div with data-testid
    - `@/lib/sounds`: mock all
    - `@/components/BetaDisclaimer`: mock as div

11. Test cases:
    - Renders create tab by default
    - Switching to orders tab shows order list
    - Connect wallet prompt when disconnected
    - Price preset buttons (-10%, -5%, +5%, +10%) update target price
    - Stablecoin detection: when tokenOut is USDC, labels adjust
    - Submit calls `createOrder` with correct `OrderType.LIMIT`
    - Cancel button calls `cancelOrder` with orderId
    - Shows `isSubmitting` loading state

**File: `src/components/OrderDashboard.test.tsx`**

12. Mock `@/hooks/useOrderEngine` with fixture data:
    - 2 active orders, 1 filled, 1 cancelled, 1 expired

13. Test cases:
    - Renders filter tabs (active, completed, cancelled)
    - Active tab shows 2 orders
    - Completed tab shows 1 filled order
    - Cancelled tab shows 2 orders (cancelled + expired)
    - Each order shows correct status badge and color
    - Cancel button calls `cancelOrder`
    - Loading state shows skeletons
    - Disconnected state shows connect prompt

**Do NOT:**
- Test `useOrderEngine` internals from component tests — it's tested in P81
- Use snapshot tests
- Modify any production source files
- Test `BackgroundMusic`, `ParticleNetwork`, or other Tier 4 components (out of scope)

**Files affected:**
- `src/hooks/useDebounce.test.ts` (NEW)
- `src/hooks/useEthGasCost.test.ts` (NEW)
- `src/components/QuoteBreakdown.test.tsx` (NEW)
- `src/components/LimitOrderPanel.test.tsx` (NEW)
- `src/components/OrderDashboard.test.tsx` (NEW)

**Expected output:** 1 commit, ~35-40 new test cases across 5 files. All existing tests still pass.

**Quality criteria:**
- `npm test` passes (0 failures)
- `npx tsc --noEmit` passes (0 type errors)
- `useDebounce` has full branch coverage (immediate, delayed, cancelled, delay-change)
- `useEthGasCost` arithmetic verified with known inputs
- `calculateAutoSlippage` + `safeBigInt` guards tested in component context
- All component tests independent (no shared state between `it` blocks)

---

## Sprint totals

| Metric | Target |
|--------|--------|
| New test files | 12 |
| New test cases | ~145-165 |
| Hooks covered | 7 (useSplitSwap, useSplitRoute, useLimitOrder, useConditionalOrder, useOrderEngine, useDebounce, useEthGasCost) |
| Components covered | 6 (SlippageModal, TokenSelector, SwapBox, QuoteBreakdown, LimitOrderPanel, OrderDashboard) |
| Total hooks tested after sprint | 12/17 (71%) |
| Total components tested after sprint | 10/42 (24%) |
| Security validations tested | fee integrity, router whitelist, calldata selector, calldata length, recipient, EIP-712 domain (×3 hooks), nonce management, routerDataHash [C-01], safeBigInt [10-L-01] |
