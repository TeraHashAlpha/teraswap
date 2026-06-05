# Sprint 42 — L2 Order Engine Security Cleanup (Pre-Phase 2)

**Sprint goal:** Close ALL deferred L2/order-engine findings from the comprehensive audit (2026-05-28) before any Phase 2 deployment. After this sprint, the order engine codebase matches the same 0C/0H/0M standard as the mainnet swap path.  
**Branch:** `fix/sprint-42-order-engine-cleanup` (from `main`)  
**Prerequisite:** Sprint 41 merged. Mainnet swap path at 0C/0H/0M/0L.  
**Test count baseline:** 1204 (vitest count after Sprint 41)  
**Findings addressed:** FULL-H-04, FULL-M-03, FULL-M-05, FULL-M-06, FULL-M-07

---

## Background

The comprehensive audit (2026-05-28) found 0C/4H/9M/8L/6I. Sprints 39–41 closed everything on the mainnet swap path. Five findings were deferred because they only affect the order engine (DCA/Limit/SL·TP), which is L2-only per the L2-only decision (2026-05-28):

- **FULL-H-04:** `price-monitor.ts:64-76` — `getChainlinkPriceUSD` destructures only `answer`, ignores `updatedAt`, `roundId`, `answeredInRound`. Stale/frozen rounds are treated as live prices for SL/TP/DCA trigger evaluation. Contradicts CLAUDE.md Do-NOT #9.
- **FULL-M-03:** `chainlink.ts:247-261` — `fetchHistoricalPrice` / `getRoundData` skips round-completeness and staleness checks. DCA price history may use incomplete rounds.
- **FULL-M-05:** `useConditionalOrder.ts:126-174` — `pollOrders` captures a stale order snapshot at effect setup; the `setInterval` callback closes over the snapshot instead of re-reading `ordersRef.current` inside the callback.
- **FULL-M-06:** `useOrderEngine.ts:332-490` — Two orders created in quick succession read the same on-chain `nonce`, producing two orders with the same nonce. The second may be unexecutable.
- **FULL-M-07:** `useConditionalOrder.ts:271-296` — `createOrder` accepts trigger parameters with no validation that the trigger is on the correct side of the current price. An already-satisfied trigger fires on the first poll tick (~5s).

These must be fixed before the order engine goes live on any chain (Base L2).

---

## P211 — Oracle staleness for conditional orders

### Context

The swap-path oracle (`src/lib/chainlink.ts:175-182`) correctly validates `answer <= 0`, `answeredInRound < roundId`, and age > `CHAINLINK_MAX_STALENESS_SEC`. Two other oracle paths in the order-engine do NOT:

1. **Live read** (`src/lib/price-monitor.ts:64-76`): `getChainlinkPriceUSD` reads `latestRoundData()` but only destructures `answer`. Used by SL/TP/DCA trigger evaluation.
2. **Historical read** (`src/lib/chainlink.ts:247-261`): `fetchHistoricalPrice` / `getRoundData` only destructures `[, answer, , updatedAt]`. Used by DCA price history.

### Objective

Apply the same staleness/validity guards from `chainlink.ts:175-182` to both the price-monitor live read and the chainlink historical read.

### Requirements

1. **`price-monitor.ts:getChainlinkPriceUSD`** — destructure ALL fields from `latestRoundData()`:
   ```typescript
   const [roundId, answer, startedAt, updatedAt, answeredInRound] = result
   ```
   Apply the same gates as `chainlink.ts`:
   - `answer <= 0n` → return `null`
   - `answeredInRound < roundId` → return `null` (stale round)
   - `updatedAt` older than `CHAINLINK_MAX_STALENESS_SEC` → return `null`
   - `startedAt <= 0n` → return `null` (incomplete round)
   
   When returning `null`, log a warning: `[TeraSwap] Chainlink price stale/invalid for ${symbol}: round=${roundId}, answeredInRound=${answeredInRound}, age=${ageSeconds}s`
   
   Import `CHAINLINK_MAX_STALENESS_SEC` from `chainlink.ts` (or the shared constants). If it's not exported, export it.

2. **`chainlink.ts:fetchHistoricalPrice` / `getRoundData`** — destructure all 5 fields and apply:
   - `answer <= 0n` → skip this round (return null for this data point)
   - `answeredInRound < roundId` → skip (incomplete round)
   - `startedAt <= 0n` → skip (not started)
   - Staleness check is NOT needed here (historical rounds are inherently in the past), but completeness checks are required.

3. **`isTriggerMet` fallback.** When `getChainlinkPriceUSD` returns `null` (stale), `isTriggerMet` must NOT fire the trigger. The current code rejects `currentPrice <= 0` (line 134) but a `null` return needs explicit handling:
   ```typescript
   const currentPrice = await getChainlinkPriceUSD(...)
   if (currentPrice === null) {
     console.warn('[TeraSwap] Skipping trigger check — oracle unavailable')
     return false // Do not fire on stale data
   }
   ```

4. **Shared validation helper (optional but preferred).** If the staleness/validity logic can be cleanly extracted to a `validateRoundData(roundId, answer, startedAt, updatedAt, answeredInRound): boolean` function in `chainlink.ts`, do so and use it in all three paths (swap, price-monitor, historical). This eliminates the "two oracle code paths with divergent rigor" architectural observation from the audit.

### Do NOT

- Do NOT change the swap-path oracle (`chainlink.ts:175-182`) behavior — only add guards to the order-engine paths
- Do NOT change `CHAINLINK_MAX_STALENESS_SEC` value
- Do NOT change how the price-monitor polling interval works
- Do NOT change the Chainlink feed registry or feed addresses

### Files affected

- `src/lib/price-monitor.ts` — add staleness/validity guards to `getChainlinkPriceUSD`
- `src/lib/chainlink.ts` — add completeness guards to `fetchHistoricalPrice`/`getRoundData`, optionally extract shared validator
- `src/lib/chainlink.ts` — export `CHAINLINK_MAX_STALENESS_SEC` if not already exported

### Expected output

1 commit: `fix(security): add oracle staleness checks to conditional-order paths [P211]`

### Quality criteria

- `getChainlinkPriceUSD` returns `null` on stale/invalid data (same gates as swap path)
- `fetchHistoricalPrice` skips incomplete rounds
- `isTriggerMet` returns `false` when oracle is unavailable
- All three oracle paths use consistent validation logic
- `npm run typecheck` passes
- All existing tests pass

---

## P212 — Conditional order poll stale snapshot fix

### Context

`useConditionalOrder.ts:126-174` sets up a `setInterval` to poll submitted orders. The order list is captured ONCE at effect setup (line ~128-130) and closed over inside the interval callback. The interval only re-creates when `submittedCount` changes. If an order transitions to `submitted` without changing the total count (one fills as another submits), the interval polls the old set and never picks up the new order.

Compare with `useLimitOrder.pollAll` (line ~75) which correctly re-reads the ref *inside* the callback.

### Objective

Fix the stale closure by reading `ordersRef.current` inside the interval callback, not at effect setup.

### Requirements

1. **Move ref read inside callback.** The `ordersRef.current.filter(o => o.status === 'submitted')` read must happen INSIDE the `setInterval` callback, not outside it:

   ```typescript
   // BEFORE (stale):
   const submitted = ordersRef.current.filter(o => o.status === 'submitted')
   const interval = setInterval(() => {
     // uses `submitted` (captured once, never refreshed)
     for (const order of submitted) { ... }
   }, POLL_INTERVAL)
   
   // AFTER (correct):
   const interval = setInterval(() => {
     const submitted = ordersRef.current.filter(o => o.status === 'submitted')
     if (submitted.length === 0) return
     for (const order of submitted) { ... }
   }, POLL_INTERVAL)
   ```

2. **Keep count as effect gate.** The `submittedCount` dependency that triggers effect re-creation should remain — it's the mechanism that starts/stops the interval. The fix is about what the interval *reads* when it fires.

3. **Guard empty list.** If the re-read inside the callback returns an empty list, skip the poll iteration (don't make unnecessary API calls).

### Do NOT

- Do NOT change the polling interval duration
- Do NOT change the CoW Protocol API interaction
- Do NOT change `useLimitOrder` — it's already correct (it's the reference pattern)
- Do NOT change the `ordersRef` update mechanism

### Files affected

- `src/hooks/useConditionalOrder.ts` — move ref read inside interval callback

### Expected output

1 commit: `fix(bug): read ordersRef inside poll callback to prevent stale snapshot [P212]`

### Quality criteria

- Interval callback reads fresh `ordersRef.current` on every tick
- New submitted orders are picked up without needing a count change
- `npm run typecheck` passes
- All existing tests pass

---

## P213 — Order nonce collision prevention

### Context

`useOrderEngine.ts:332-490` reads `nonce` from the on-chain `nonces(user)` call via wagmi's `useReadContract`. Two orders created in quick succession (before wagmi re-fetches) read the same `currentNonce`, producing two orders with the same nonce value. The OrderExecutor v2 uses nonces for replay protection — the second order with the same nonce may be unexecutable.

### Objective

Prevent nonce collision by tracking a local session nonce that increments on each order creation.

### Requirements

1. **Local nonce tracking.** Add a `localNonceRef = useRef<bigint | null>(null)` that tracks the highest nonce used in this session:

   ```typescript
   function getNextNonce(): bigint {
     const onChainNonce = currentNonce ?? 0n
     const localNonce = localNonceRef.current
     
     // Use whichever is higher: on-chain (may have advanced from other sessions)
     // or local+1 (if we've created orders this session)
     const next = localNonce !== null 
       ? (localNonce + 1n > onChainNonce ? localNonce + 1n : onChainNonce)
       : onChainNonce
     
     localNonceRef.current = next
     return next
   }
   ```

2. **Use in `createOrder`.** Replace the direct `currentNonce` read with `getNextNonce()` when building the order's nonce field.

3. **Force refetch after creation.** After a successful order creation (Supabase insert succeeds), call `refetch()` on the nonces read contract to sync with on-chain state. This ensures the on-chain nonce catches up for the next comparison.

4. **Concurrent create guard.** Add a `creatingRef = useRef(false)` mutex to prevent concurrent `createOrder` calls. If `creatingRef.current === true`, reject with an error: `"Order creation in progress — please wait"`.

5. **Reset on disconnect.** When `address` changes or disconnects, reset `localNonceRef.current = null`.

### Do NOT

- Do NOT change the OrderExecutor contract nonce model
- Do NOT change the EIP-712 order signing flow (only the nonce value changes)
- Do NOT change Supabase insert logic
- Do NOT change wagmi's `useReadContract` configuration

### Files affected

- `src/hooks/useOrderEngine.ts` — local nonce tracking, concurrent guard, refetch after create

### Expected output

1 commit: `fix(bug): prevent order nonce collision with local session tracking [P213]`

### Quality criteria

- Two rapid order creations produce different nonces
- Local nonce defers to on-chain nonce if it's higher (other session/device advanced it)
- Concurrent create attempts are rejected with a clear error
- `localNonceRef` resets on account switch
- `npm run typecheck` passes
- All existing tests pass

---

## P214 — Trigger direction validation at order creation

### Context

`useConditionalOrder.ts:271-296` accepts `triggerDirection` (ABOVE/BELOW) and `triggerPrice` with no check that the trigger is on the correct side of the current price. An order whose condition is already satisfied at creation time fires on the first poll tick (~5s) instead of being rejected.

### Objective

Add pre-creation validation that the trigger price is on the correct side of the current market price.

### Requirements

1. **Fetch current price at creation.** Before signing the order, fetch the current Chainlink price for the token pair using the (now staleness-guarded from P211) `getChainlinkPriceUSD` or `useChainlinkPrice`.

2. **Validate trigger vs current price:**

   ```typescript
   if (triggerDirection === 'ABOVE' && currentPrice >= triggerPrice) {
     throw new Error(
       `Trigger price (${triggerPrice}) must be above current price (${currentPrice}) for ABOVE condition`
     )
   }
   if (triggerDirection === 'BELOW' && currentPrice <= triggerPrice) {
     throw new Error(
       `Trigger price (${triggerPrice}) must be below current price (${currentPrice}) for BELOW condition`
     )
   }
   ```

3. **Oracle unavailable fallback.** If the current price cannot be fetched (oracle stale/unavailable after P211 guards), allow the order creation with a warning:
   ```typescript
   if (currentPrice === null) {
     console.warn('[TeraSwap] Cannot validate trigger — oracle unavailable. Proceeding with user-provided values.')
     // Don't block — the user accepted the trigger values
   }
   ```

4. **Surface error in UI.** The error should propagate to the UI via the existing error state mechanism so the user sees why their order was rejected. The error message should be user-friendly.

5. **DCA exception.** DCA orders may not have a meaningful trigger price (they execute on schedule). If `orderType === 'DCA'`, skip the trigger validation.

### Do NOT

- Do NOT change `isTriggerMet` logic — that's the execution-time check
- Do NOT add a mandatory price fetch that blocks order creation on oracle failure
- Do NOT change the EIP-712 order structure
- Do NOT change the trigger evaluation semantics (ABOVE = `>=`, BELOW = `<=`)

### Files affected

- `src/hooks/useConditionalOrder.ts` — add trigger validation in `createOrder`

### Expected output

1 commit: `fix(ux): validate trigger direction vs current price at order creation [P214]`

### Quality criteria

- ABOVE trigger with current price already above → rejected with clear message
- BELOW trigger with current price already below → rejected with clear message
- Oracle unavailable → warning but order proceeds
- DCA orders → no trigger validation
- `npm run typecheck` passes
- All existing tests pass

---

## P215 — Tests

### Context

P211-P214 fixed oracle staleness, stale poll snapshot, nonce collision, and trigger validation. This prompt adds test coverage for all four fixes, plus the TEST-M-02 gap (price-monitor untested) from the comprehensive audit.

### Requirements

#### Oracle staleness tests (in `src/lib/price-monitor.test.ts` — CREATE)

1. **`'returns null on stale round'`** — mock `latestRoundData` with `updatedAt` beyond staleness threshold. Verify `getChainlinkPriceUSD` returns `null`.
2. **`'returns null on incomplete round'`** — mock with `answeredInRound < roundId`. Verify returns `null`.
3. **`'returns null on zero/negative answer'`** — mock with `answer = 0n` and `answer = -1n`. Verify returns `null`.
4. **`'returns valid price on good round'`** — mock with all checks passing. Verify returns correct `Number(answer)/10**decimals`.
5. **`'isTriggerMet returns false when oracle unavailable'`** — mock `getChainlinkPriceUSD` to return `null`. Verify `isTriggerMet` returns `false`.

#### Historical price tests (in `src/lib/chainlink.test.ts` — ADD)

6. **`'fetchHistoricalPrice skips incomplete rounds'`** — mock `getRoundData` with `answeredInRound < roundId`. Verify that round is skipped (returns null or excluded from result).
7. **`'fetchHistoricalPrice skips rounds with zero answer'`** — mock with `answer = 0n`. Verify skipped.

#### Conditional order poll test (in `src/hooks/useConditionalOrder.test.ts` — CREATE or ADD)

8. **`'poll reads fresh ordersRef on each tick'`** — set up interval, add a new submitted order after first tick, verify it's polled on the next tick without needing a count change.

#### Nonce collision tests (in `src/hooks/useOrderEngine.test.ts` — ADD)

9. **`'sequential creates get incrementing nonces'`** — mock `currentNonce` returning 5n. Create two orders. Verify first gets nonce 5n, second gets 6n.
10. **`'rejects concurrent create attempts'`** — trigger two `createOrder` calls simultaneously. Verify the second is rejected with "in progress" error.
11. **`'resets local nonce on account switch'`** — create an order (nonce cached), switch account, verify local nonce is reset.

#### Trigger validation tests (in `src/hooks/useConditionalOrder.test.ts` — ADD)

12. **`'rejects ABOVE trigger when current price already above'`** — mock current price at 2000, set trigger ABOVE at 1900. Verify rejection.
13. **`'rejects BELOW trigger when current price already below'`** — mock current price at 1800, set trigger BELOW at 1900. Verify rejection.
14. **`'allows valid trigger configuration'`** — mock current price at 2000, set trigger ABOVE at 2100. Verify accepted.
15. **`'skips trigger validation for DCA orders'`** — create DCA order with no trigger check. Verify accepted regardless.

### Do NOT

- Do NOT test Chainlink contract interaction (mock at the client level)
- Do NOT add external dependencies
- Do NOT modify production code in this prompt

### Files affected

- `src/lib/price-monitor.test.ts` — **CREATE** (5 tests)
- `src/lib/chainlink.test.ts` — ADD (2 tests)
- `src/hooks/useConditionalOrder.test.ts` — **CREATE or ADD** (4 tests)
- `src/hooks/useOrderEngine.test.ts` — ADD (3 tests)

### Expected output

1 commit: `test: add oracle staleness, poll snapshot, nonce, and trigger tests [P215]`

### Quality criteria

- All 15 new tests pass
- All existing tests pass
- `npm run typecheck` passes
- Test count: 1204 + 15 = **~1219**

---

## Sprint Summary

| Prompt | Scope | Files | Finding(s) Closed |
|--------|-------|-------|-------------------|
| P211 | Oracle staleness for conditional orders | 2-3 files | **FULL-H-04** + **FULL-M-03** |
| P212 | Conditional order poll stale snapshot | 1 file | **FULL-M-05** |
| P213 | Order nonce collision prevention | 1 file | **FULL-M-06** |
| P214 | Trigger direction validation | 1 file | **FULL-M-07** |
| P215 | Tests | 4 files | Coverage (TEST-M-02) |

**Total estimated scope:** 5 commits, ~8 files, ~15 new tests.

**Test count target:** ~1219

**Risk assessment:** MEDIUM. P211 changes oracle reads that gate real swap executions (but order engine is not yet live on any chain). P212-P214 are bug fixes in hooks. All changes are to code that is currently inactive on mainnet (order engine is L2-only).

**Dependency chain:** P211 before P214 (P214 needs staleness-guarded oracle from P211). P212 and P213 are independent. P215 depends on all four.

**Post-sprint state:** Order engine at **0C / 0H / 0M** for all comprehensive audit findings. Ready for Phase 2 (Base L2) deployment alongside the multi-chain foundation sprint.

---

_Sprint 42 closes FULL-H-04, FULL-M-03, FULL-M-05, FULL-M-06, FULL-M-07. After this sprint, all deferred L2 findings are resolved. The order engine is audit-clean for Base deployment._
