# Sprint 40 — Security Hardening (Audit Follow-Up)

**Sprint goal:** Close the 2 remaining HIGH findings and 2 critical test gaps identified by the 2026-05-28 comprehensive audit (QUESTIONS.md). Add spender allowlist, order cancel authentication, recipient validation tightening, swap state reset on account switch, and oracle/price-guard unit tests.  
**Branch:** `fix/sprint-40-security` (from `main`)  
**Prerequisite:** Sprint 39 merged (adds SecureStorage + encrypted keys — closes FULL-H-03).  
**Test count baseline:** ~1184 (after Sprint 39)  
**Findings addressed:** FULL-H-01, FULL-H-02, FULL-M-01, FULL-M-04, FULL-L-04, TEST-H-01, TEST-H-02, INFO-01

---

## Background

The comprehensive codebase audit (Opus 4.8, 2026-05-28) confirmed 0 Critical and verified all prior Critical/High findings as fixed. It identified 4 new HIGHs — two of which (H-03: SecureStorage dead code, H-04: conditional-order oracle staleness) are resolved by Sprint 39 and the L2-only decision respectively. The remaining **2 HIGHs** are:

1. **FULL-H-01:** `PATCH /api/orders/[id]` cancels orders based solely on a `wallet` value in the request body — no signature, no SIWE, no cryptographic proof. Any party knowing a wallet address + order ID can cancel another user's active orders.
2. **FULL-H-02:** The ERC-20 approval spender address is trusted verbatim from `/api/spender` with no client-side allowlist. If the endpoint is compromised or MITM'd, the user approves `transferFrom` to an attacker address.

Both are bounded (H-01: no fund theft, only griefing/DoS; H-02: exact-amount approvals limit exposure), but both are real financial-harm vectors for a DEX handling user funds.

Additionally, the two most critical security controls — Chainlink staleness validation and DefiLlama deviation math — have **zero unit tests** (TEST-H-01, TEST-H-02).

---

## P202 — Authenticated order cancellation (EIP-712 signature)

### Context

`POST /api/orders` correctly recovers the signer via `recoverTypedDataAddress` and compares against the declared wallet (lines 152-161 of `orders/route.ts`). The `PATCH /api/orders/[id]` handler does not — it trusts the `wallet` field from the request body with no cryptographic proof (lines 54-59 of `orders/[id]/route.ts`). Wallet addresses are public, and order IDs are obtainable via `GET /api/orders?wallet=`.

### Objective

Add EIP-712 signature verification to the cancel endpoint, mirroring the creation flow. The frontend must sign a `CancelOrder` typed data message; the API must recover the signer and compare to the order owner.

### Requirements

#### 1. Define `CancelOrder` EIP-712 types

In `src/lib/order-engine/config.ts`, add:

```typescript
export const CANCEL_ORDER_TYPES = {
  CancelOrder: [
    { name: 'id', type: 'string' },       // Supabase order UUID
    { name: 'action', type: 'string' },    // Always "cancel" — prevents type collision
  ],
} as const
```

Re-use the existing `getOrderExecutorDomain(chainId)` for the domain — same contract, same chain binding.

#### 2. Update PATCH handler to require + verify signature

In `src/app/api/orders/[id]/route.ts`, the PATCH handler must:

1. Extract `wallet`, `signature`, and `chainId` from the request body (all required)
2. Validate `wallet` format (existing regex — keep)
3. Validate `signature` is a hex string (`/^0x[0-9a-fA-F]+$/`)
4. Validate `chainId` is a number
5. Build the `CancelOrder` message: `{ id: params.id, action: 'cancel' }`
6. Call `recoverTypedDataAddress` with:
   - `domain`: `getOrderExecutorDomain(chainId)`
   - `types`: `CANCEL_ORDER_TYPES`
   - `primaryType`: `'CancelOrder'`
   - `message`: the cancel message
   - `signature`: the hex signature
7. Compare recovered address (lowercase) to `wallet` (lowercase). If mismatch → 400 `'Signature verification failed'`
8. Proceed with the existing atomic update (`status = 'cancelled'` WHERE `wallet` + `status = 'active'`)
9. Wrap recovery in try/catch — on error → 400 `'Invalid cancel signature'`

Import `recoverTypedDataAddress` from `viem` (already a project dependency — used in `orders/route.ts`).

#### 3. Update frontend cancel flow

In `src/hooks/useOrderEngine.ts`, the `cancelOrder` function must:

1. Sign a `CancelOrder` EIP-712 message before calling the API:
   ```typescript
   const signature = await signTypedDataAsync({
     domain: getOrderExecutorDomain(chainId),
     types: CANCEL_ORDER_TYPES,
     primaryType: 'CancelOrder',
     message: { id: orderId, action: 'cancel' },
   })
   ```
2. Include `signature` and `chainId` in the PATCH request body alongside `wallet`
3. Handle signature rejection (user declines in wallet) — set order status back, show error

The hook already uses `useSignTypedData` from wagmi for order creation — use the same pattern.

#### 4. Update limit order and conditional order cancel

In `src/hooks/useLimitOrder.ts` and `src/hooks/useConditionalOrder.ts`, if they have their own cancel functions that call the same API endpoint, update them to include the signature. If they delegate to `useOrderEngine.cancelOrder`, no change needed.

### Do NOT

- Do NOT change the POST (create) signature flow — it's already correct
- Do NOT add SIWE — EIP-712 is simpler and consistent with the existing pattern
- Do NOT change the GET endpoint auth model — it returns public on-chain data (INFO-04, accepted)
- Do NOT change Supabase schema — no new columns needed

### Files affected

- `src/lib/order-engine/config.ts` — add `CANCEL_ORDER_TYPES`
- `src/app/api/orders/[id]/route.ts` — add signature verification to PATCH
- `src/hooks/useOrderEngine.ts` — sign CancelOrder before PATCH
- `src/hooks/useLimitOrder.ts` — update cancel if it has its own implementation
- `src/hooks/useConditionalOrder.ts` — update cancel if it has its own implementation

### Expected output

1 commit: `fix(security): require EIP-712 signature for order cancellation [P202]`

### Quality criteria

- `recoverTypedDataAddress` used (not a custom recovery)
- Signature required — PATCH without signature returns 400
- Recovered address compared to order owner
- Frontend signs before calling API
- Wallet rejection handled gracefully (no crash, order not stuck)
- `npm run typecheck` passes

---

## P203 — Client-side spender address allowlist

### Context

The ERC-20 allowance spender address comes from `/api/spender` and is used directly in `useApproval.ts` `approve()` (line ~194: `writeExactApprove({ args: [spenderAddress, rawAmount] })`). The server returns only trusted constants, but the client does not validate the response. If the endpoint or its upstream is compromised, the user signs `approve(attacker, amount)`.

### Objective

Add a client-side allowlist validation for the spender address before any approval transaction is signed.

### Requirements

#### 1. Create trusted spender set

In `src/lib/constants.ts` (or a new `src/lib/trusted-addresses.ts` if constants.ts is too large), define:

```typescript
export const TRUSTED_SPENDER_ADDRESSES: ReadonlySet<string> = new Set([
  process.env.NEXT_PUBLIC_FEE_COLLECTOR_ADDRESS?.toLowerCase(),
  process.env.NEXT_PUBLIC_FEE_COLLECTOR_V1_ADDRESS?.toLowerCase(),
  process.env.NEXT_PUBLIC_PERMIT2_ADDRESS?.toLowerCase(),
  // Add all known router addresses from the router whitelist
  ...WHITELISTED_ROUTERS.map(r => r.toLowerCase()),
  // CoW vault relayer
  process.env.NEXT_PUBLIC_COW_VAULT_RELAYER?.toLowerCase(),
].filter(Boolean) as string[])

export function isTrustedSpender(address: string): boolean {
  return TRUSTED_SPENDER_ADDRESSES.has(address.toLowerCase())
}
```

If `WHITELISTED_ROUTERS` is already defined in the existing router validation module, import from there. Do NOT duplicate the list.

#### 2. Validate spender in SwapBox before setting state

In `src/components/SwapBox.tsx`, where the spender is received from the API (around line 127-133), add validation:

```typescript
import { isTrustedSpender } from '@/lib/constants' // or trusted-addresses

// After receiving spender from API:
if (spenderAddress && !isTrustedSpender(spenderAddress)) {
  console.error('[Security] Untrusted spender address from /api/spender:', spenderAddress)
  setError('Swap unavailable — spender validation failed. Please try again.')
  return // Do NOT set the spender state
}
```

#### 3. Defense-in-depth: validate in useApproval before signing

In `src/hooks/useApproval.ts`, add a guard in the `approve()` function (before the `writeExactApprove` call, around line 187-197):

```typescript
if (!isTrustedSpender(spenderAddress)) {
  console.error('[Security] Blocked approval to untrusted spender:', spenderAddress)
  throw new Error('Approval blocked: untrusted spender address')
}
```

This is a second layer — even if SwapBox is bypassed, the hook rejects it.

### Do NOT

- Do NOT change the `/api/spender` server-side logic — it's already correct
- Do NOT add the allowlist server-side only — the point is to protect against server compromise
- Do NOT hardcode addresses as string literals — use env vars and the existing router whitelist
- Do NOT block Permit2 address — it's a legitimate spender for permit-based approvals

### Files affected

- `src/lib/constants.ts` (or new `src/lib/trusted-addresses.ts`) — trusted spender set
- `src/components/SwapBox.tsx` — validate before setting spender state
- `src/hooks/useApproval.ts` — defense-in-depth validation before signing

### Expected output

1 commit: `fix(security): add client-side spender address allowlist [P203]`

### Quality criteria

- All known spenders included (routers + FeeCollector V1/V2 + Permit2 + CoW vault relayer)
- Untrusted spender blocked with error message — no silent failure
- Two validation points (SwapBox + useApproval)
- Existing swap flows unaffected (all current spenders are in the set)
- `npm run typecheck` passes
- All existing tests pass

---

## P204 — Recipient validation tightening + swap state reset

### Context

Two MEDIUM findings from the comprehensive audit:

1. **FULL-M-01:** `isValidRecipient()` in `calldata-recipient.ts` accepts the FeeCollector address on ALL routes, including direct (non-fee) routes. A compromised aggregator response on a direct route could redirect output to the FeeCollector.

2. **FULL-M-04:** On account switch/disconnect mid-flow, `useSwap` does not reset `pendingSwap` or other swap state. A stale `pendingSwap` bound to wallet A can be confirmed under wallet B.

### Objective

Parameterize recipient validation by route type, and add swap state reset on account change.

### Requirements

#### Part A — Recipient validation (FULL-M-01)

1. In `src/lib/calldata-recipient.ts`, modify `isValidRecipient` to accept a `routeViaFeeCollector` parameter:

   ```typescript
   function isValidRecipient(
     extracted: string,
     expected: string,
     routeViaFeeCollector: boolean = true  // Default true for backwards compatibility
   ): boolean {
     const validAddresses = [expected.toLowerCase()]
     if (routeViaFeeCollector) {
       if (FEE_COLLECTOR_ADDRESS) {
         validAddresses.push(FEE_COLLECTOR_ADDRESS.toLowerCase())
       }
       validAddresses.push(FEE_COLLECTOR_V1_ADDRESS.toLowerCase())
     }
     return validAddresses.includes(extracted.toLowerCase())
   }
   ```

2. Update the `validateCallDataRecipient` public function signature to accept and pass through `routeViaFeeCollector`.

3. In callers (`useSwap.ts`, `useSplitSwap.ts`, `api/swap/route.ts`), pass `routeViaFeeCollector` based on the actual route configuration:
   - Fee-routed swaps: `routeViaFeeCollector: true`
   - Direct source swaps (where `source` is in `FEE_INCOMPATIBLE_SOURCES`): `routeViaFeeCollector: false`

4. Verify the existing `calldata-recipient.test.ts` tests still pass. Add 2 tests:
   - `'rejects FeeCollector recipient on direct route'`
   - `'accepts FeeCollector recipient on fee-routed swap'`

#### Part B — Swap state reset on account switch (FULL-M-04)

1. In `src/hooks/useSwap.ts`, add a `useEffect` keyed on `address` that resets swap state:

   ```typescript
   // Reset swap state on account switch — prevents stale pendingSwap
   // from being confirmable under a different wallet [FULL-M-04]
   const prevAddressRef = useRef(address)
   useEffect(() => {
     if (prevAddressRef.current && address && prevAddressRef.current !== address) {
       setPendingSwap(null)
       setStatus('idle')
       setErrorMessage('')
       setCowOrderUid(null)
       setTxHashState(null)
     }
     prevAddressRef.current = address
   }, [address])
   ```

2. Also reset on disconnect (`!address`):

   ```typescript
   useEffect(() => {
     if (!address) {
       setPendingSwap(null)
       setStatus('idle')
     }
   }, [address])
   ```

   Combine with the above into a single effect if cleaner.

### Do NOT

- Do NOT change the fail-closed default for `isValidRecipient` — unknown selectors must still block
- Do NOT remove FeeCollector V1 from the valid set entirely — it's still needed for historical/retry paths when `routeViaFeeCollector` is true
- Do NOT reset state on every render — only on actual address change (use ref comparison)
- Do NOT change the calldata extraction logic — only the recipient validation

### Files affected

- `src/lib/calldata-recipient.ts` — parameterize `isValidRecipient`
- `src/hooks/useSwap.ts` — add address-change reset effect
- `src/hooks/useSplitSwap.ts` — pass `routeViaFeeCollector` to validation
- `src/app/api/swap/route.ts` — pass `routeViaFeeCollector` to server-side validation
- `src/lib/calldata-recipient.test.ts` — add 2 tests

### Expected output

1 commit: `fix(security): tighten recipient validation + reset swap state on account switch [P204]`

### Quality criteria

- FeeCollector rejected as recipient on direct routes
- FeeCollector accepted on fee-routed swaps
- Swap state clears on account switch (no stale pendingSwap)
- All existing calldata-recipient tests pass (no regression)
- 2 new tests added
- `npm run typecheck` passes

---

## P205 — Oracle and price-guard unit tests

### Context

Two TEST-HIGH gaps from the comprehensive audit:

1. **TEST-H-01:** `src/lib/chainlink.ts` lines 177-179 — the `answeredInRound < roundId → null` and `age > CHAINLINK_MAX_STALENESS_SEC → null` staleness gates have **zero unit tests**. A flipped comparison operator would pass undetected.

2. **TEST-H-02:** `src/lib/defillama.ts` `validateSwapPrice` — the core anti-manipulation control for swaps >$10k. The route test (`swap/route.test.ts`) **mocks** `validateSwapPrice` entirely, so it only verifies the 422 wiring, never the deviation arithmetic or the high-value boundary.

### Objective

Create dedicated test files for both modules, covering the security-critical code paths.

### Requirements

#### 1. Chainlink tests (`src/lib/chainlink.test.ts` — CREATE)

Mock `rpcCall` (the internal function that calls `eth_call`) to return controlled `latestRoundData` responses. Test:

1. **`'returns price for valid fresh round'`** — `answer > 0`, `answeredInRound === roundId`, `updatedAt` within max staleness → returns `{ price, updatedAt, roundId }`.

2. **`'returns null for stale round (answeredInRound < roundId)'`** — set `answeredInRound` = `roundId - 1n` → returns `null`.

3. **`'returns null for expired data (age > CHAINLINK_MAX_STALENESS_SEC)'`** — set `updatedAt` to `Date.now()/1000 - CHAINLINK_MAX_STALENESS_SEC - 1` → returns `null`.

4. **`'returns null for zero answer'`** — `answer = 0n` → returns `null`.

5. **`'returns null for negative answer'`** — `answer = -1n` → returns `null`.

6. **`'returns null on RPC failure'`** — mock `rpcCall` to throw → returns `null` (fail-closed).

7. **`'correctly decodes 8-decimal feed (ETH/USD)'`** — verify `Number(answer) / 10 ** 8` math with a realistic ETH price.

8. **`'correctly decodes 18-decimal feed'`** — verify decimal handling for different feed precisions.

#### Notes on mocking

The `chainlink.ts` module uses an internal `rpcCall` helper. To mock it:
- If it's exported: mock directly
- If it's not exported: mock the underlying `fetch` or the `publicClient.call` (depending on implementation)
- Alternatively, mock at the `viem` level (`decodeFunctionResult`)

Check the actual implementation to determine the right mock point. The goal is to control the raw `latestRoundData` return values.

#### 2. DefiLlama tests (`src/lib/defillama.test.ts` — CREATE)

Mock `fetchDefiLlamaPrice` (the internal function that calls the DefiLlama API). Test:

1. **`'returns valid=true for normal swap (deviation within threshold)'`** — token prices yield ~2% negative deviation (fees + slippage) → `valid: true, blocked: false`.

2. **`'returns blocked=true for >8% deviation'`** — prices yield -9% deviation → `valid: false, blocked: true`.

3. **`'returns blocked=true at exact -8% boundary'`** — edge case at `BLOCK_THRESHOLD` → verify boundary is correct (strictly less than -0.08).

4. **`'returns null for small swap with missing oracle'`** — one price unavailable, `estimatedValueUsd < HIGH_VALUE_THRESHOLD_USD` → returns `null` (fail-open for small swaps).

5. **`'blocks high-value swap with missing oracle'`** — one price unavailable, `estimatedValueUsd > HIGH_VALUE_THRESHOLD_USD` → `blocked: true` (fail-closed for large swaps).

6. **`'blocks high-value swap with low confidence oracle'`** — confidence < 0.5 + high value → `blocked: true`.

7. **`'returns null for low confidence on small swap'`** — confidence < 0.5 + small value → `null` (fail-open).

8. **`'calculates deviation correctly with real token decimals'`** — use realistic WETH/USDC values (18 vs 6 decimals) to verify the math handles decimal asymmetry.

9. **`'returns null on calculation error (small swap)'`** — mock to throw inside try/catch → `null`.

10. **`'blocks on calculation error (high-value swap)'`** — mock to throw + high value → `blocked: true`.

#### Notes on constants

`HIGH_VALUE_THRESHOLD_USD` and `BLOCK_THRESHOLD` should be imported from the module (export them if not already exported) or read from the source. Do NOT hardcode magic numbers in tests — reference the constants.

### Do NOT

- Do NOT test the exact HTTP calls to DefiLlama — mock at the price-fetch level
- Do NOT modify chainlink.ts or defillama.ts logic — this prompt is tests only
- Do NOT mock at too high a level (e.g., mocking the entire module) — test the real arithmetic

### Files affected

- `src/lib/chainlink.test.ts` — **CREATE** (8 tests)
- `src/lib/defillama.test.ts` — **CREATE** (10 tests)

### Expected output

1 commit: `test(security): add Chainlink staleness and DefiLlama deviation unit tests [P205]`

### Quality criteria

- All security gates tested (stale round, expired data, zero/negative answer, deviation threshold, high-value block)
- Boundary conditions tested (exact -8%, exact max staleness)
- Fail-closed behaviour verified (large swaps block when oracle unavailable)
- Fail-open behaviour verified (small swaps pass when oracle unavailable)
- Decimal handling tested (8-decimal and 18-decimal feeds, 6-decimal USDC)
- No external network calls in tests (all mocked)
- All new tests pass
- All existing tests pass
- `npm run typecheck` passes

---

## P206 — Cleanup: dead imports + stale CoW warning

### Context

Two low-impact findings from the comprehensive audit that can be cleaned up alongside the security work:

1. **INFO-01:** `PERMIT2_DOMAIN` and `ORDER_EXECUTOR_DOMAIN` are deprecated hardcoded-chainId domains, still imported but used in no live signature path. Dead code / maintenance hazard.

2. **FULL-L-04:** CoW path records `method:'infinite'` + `needsRevoke:true` and shows an "infinite allowance" warning, but approvals are now exact (`useApproval.ts:191-195`). Misleads users into chasing an unneeded revoke.

### Objective

Remove dead code and fix the stale CoW allowance warning.

### Requirements

#### 1. Remove dead EIP-712 domains (INFO-01)

- In `src/lib/approvals.ts`: remove `PERMIT2_DOMAIN` constant (lines ~52-56) and its import in `useApproval.ts`
- In `src/lib/order-engine/config.ts`: remove the deprecated `ORDER_EXECUTOR_DOMAIN` constant (lines ~27-32). Keep `getOrderExecutorDomain(chainId)` — that's the live version.
- Grep for any remaining imports of these constants and remove them
- If the deprecated constants have `@deprecated` JSDoc, their removal is safe — the doc confirms they're unused

#### 2. Fix CoW allowance warning (FULL-L-04)

- In `src/components/SwapBox.tsx` (around lines 296-308,857): update the CoW path to NOT show "infinite allowance" warning
- The CoW path should reflect the actual approval method used. Since `planApproval` now always forces `exact` (lines 100-109 of `useApproval.ts`), the CoW warning about infinite allowance is incorrect
- Remove or update `method:'infinite'` → `method:'exact'` for CoW path
- Remove or update `needsRevoke:true` → `needsRevoke:false` for CoW path
- Update any associated UI text that warns about infinite allowance

### Do NOT

- Do NOT change `getOrderExecutorDomain(chainId)` — that's the live function
- Do NOT change the actual approval logic — only fix the UI representation
- Do NOT change how Permit2 approvals work (max allowance to Permit2 is by design)

### Files affected

- `src/lib/approvals.ts` — remove `PERMIT2_DOMAIN`
- `src/lib/order-engine/config.ts` — remove deprecated `ORDER_EXECUTOR_DOMAIN`
- `src/hooks/useApproval.ts` — remove dead import
- `src/components/SwapBox.tsx` — fix CoW allowance warning

### Expected output

1 commit: `chore(cleanup): remove dead EIP-712 domains + fix stale CoW allowance warning [P206]`

### Quality criteria

- No references to removed constants remain (grep clean)
- CoW path no longer shows "infinite allowance" warning
- All existing tests pass
- `npm run typecheck` passes
- `npm run lint` passes

---

## Sprint Summary

| Prompt | Scope | Files | Finding(s) Closed |
|--------|-------|-------|-------------------|
| P202 | Cancel auth (EIP-712) | 5 edited | **FULL-H-01** |
| P203 | Spender allowlist | 3 edited/created | **FULL-H-02** |
| P204 | Recipient + swap reset | 5 edited | **FULL-M-01**, **FULL-M-04** |
| P205 | Oracle + price-guard tests | 2 created | **TEST-H-01**, **TEST-H-02** |
| P206 | Dead code + CoW warning | 4 edited | **INFO-01**, **FULL-L-04** |

**Total estimated scope:** 5 commits, ~14 files affected, ~18 new tests.

**Test count target:** ~1184 (Sprint 39) + 2 (P204) + 18 (P205) = **~1204**

**Risk assessment:** MEDIUM. P202 (cancel auth) changes a live API endpoint — must not break existing cancel flows. P203 (spender allowlist) must include ALL current legitimate spenders or swaps break. P204 (recipient) changes a security-critical validation function — requires careful testing. P205 is test-only (low risk). P206 is cleanup (low risk).

**Dependency chain:** P202 and P203 are independent. P204 is independent. P205 is independent. P206 is independent. All can be implemented in any order, but P202→P203→P204→P205→P206 is the recommended sequence (highest severity first).

**Rollback plan:** Each prompt is atomic. If P202 breaks cancellation, revert that commit only — other fixes are independent.

**Post-sprint state:** After Sprint 40, the comprehensive audit score drops from 4H/9M to **0H/7M** (assuming Sprint 39 also merged). The remaining 7M are: M-02 (split-swap simulation), M-03/M-05/M-06/M-07 (order engine — deferred to L2/Phase 2), and M-04 closed by this sprint.

---

_Sprint 40 closes FULL-H-01, FULL-H-02, FULL-M-01, FULL-M-04, FULL-L-04, TEST-H-01, TEST-H-02, INFO-01. Prerequisite: Sprint 39 merged. Audit required before merge (0C/0H gate)._
