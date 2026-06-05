# Sprint 22 — Frontend Security Hook Tests (M-01 partial)

**Date:** 2026-05-18
**Architect:** Claude (Senior Architect)
**Closes:** M-01 partial (external analysis: "zero frontend/hook test coverage")
**Branch:** `test/frontend-security-hooks` (single branch, single PR)
**Estimated effort:** ~0.25 pw (2 prompts)

---

## Motivation

The external technical analysis (2026-04-22) classified M-01 as MEDIUM severity
with "Real Risk: HIGH" — the frontend is the user's last line of defence before
signing. After Sprint 19B (swap route tests) and Sprint 21 (monitoring
integration), the backend has solid coverage at 756 tests. But zero automated
tests exist for any React component or custom hook.

This sprint covers the two highest-risk frontend surfaces:
1. **useSwap** — the security validation chain that gates every swap execution
2. **TransactionPreview** — the "clear signing" modal that displays decoded
   calldata before user confirms

Lower-risk hooks (useApproval, useQuote) are deferred to a follow-up sprint.

**Deploy strategy:** Single branch `test/frontend-security-hooks`, one commit per
prompt, one PR. Test-only change — zero production code modified.

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 132 | useSwap security validation chain tests | 10 | 3 | 0.85 | 0.15 | 170.0 | P0 |
| 133 | TransactionPreview component tests | 8 | 2 | 0.85 | 0.10 | 136.0 | P0 |

---

## Prompt 132 — useSwap Security Validation Chain Tests

**Context:** `src/hooks/useSwap.ts` (1050 lines) orchestrates swap execution with
a blocking security chain before any transaction is sent:

1. `validateRouterAddress(tx.to, source)` — router whitelist
2. Calldata length check (`< 10` or `> 200000` → reject)
3. `KNOWN_SWAP_SELECTORS.has(selector)` — 19-selector allowlist
4. `validateCallDataRecipient(calldata, address)` — [R1] recipient check
5. `validateFeeIntegrity(quoteToAmount, swapData.toAmount, source)` — fee bypass detection
6. `simulateSwapTx` — eth_call pre-simulation

After validation, `minimumOutput` is computed from `swapData.toAmount` with
slippage. If `toAmount` is malformed or `slippageBps >= 10000`, `minimumOutput`
silently degrades to `0n` (on-chain check disabled).

The CoW path has separate validations: native ETH block, receiver ≠ address check,
validTo cap.

**Objective:** Test the security-critical validation logic in useSwap. Since testing
the full React hook requires extensive wagmi mocking, the approach is to test the
**validation functions** that useSwap imports (they are the security boundary), plus
a focused hook-level test for the `minimumOutput` degradation path which is inline.

**Requirements:**

### Part A — Validation function unit tests

Create `src/hooks/__tests__/swap-validations.test.ts` with tests for the imported
validation functions. These are already importable as standalone modules:

#### A1 — Router address validation (`src/lib/router-validation.ts` or wherever `validateRouterAddress` lives)
```
test: known router for 1inch → passes
test: known router for cowswap → passes
test: arbitrary address not in whitelist → throws
test: zero address → throws
test: source not in source list → throws
```

#### A2 — Selector allowlist (`src/lib/swap-selectors.ts`)
```
test: all 19 known selectors → isKnownSwapSelector returns true
test: 0xdeadbeef (unknown) → returns false
test: empty string → returns false
test: partial selector (3 bytes) → returns false
```

#### A3 — Calldata recipient validation (`src/lib/calldata-recipient.ts`)
```
test: Group A selector (msg.sender implicit) → valid: true, implicitRecipient: true
test: Group B selector with user address as recipient → valid: true
test: Group B selector with FeeCollector V2 address → valid: true
test: Group B selector with FeeCollector V1 address → valid: true
test: Group B selector with attacker address → valid: false, extracted: attacker addr
test: unknown selector → valid: false (fail-closed)
test: malformed calldata (too short) → valid: false
```

#### A4 — Fee integrity validation (`src/lib/fee-integrity.ts` or wherever `validateFeeIntegrity` lives)
```
test: swapToAmount within normal range of quoteToAmount → passes (no throw)
test: swapToAmount suspiciously higher than quoteToAmount → throws (fee bypass)
test: quoteToAmount is null/undefined → passes (skip validation)
test: source that doesn't use FeeCollector → passes (skip validation)
```

#### A5 — minimumOutput computation edge cases
```
test: valid toAmount with 1% slippage → correct minimumOutput (toAmount * 9900 / 10000)
test: toAmount = "abc" (NaN) → minimumOutput = 0n
test: toAmount = "0" → minimumOutput = 0n
test: toAmount = "" → minimumOutput = 0n
test: slippageBps = 10000 (100%) → minimumOutput = 0n
test: slippageBps = 9999 → minimumOutput = toAmount * 1 / 10000 (not zero)
```

Note for A5: If `minimumOutput` computation is inline in the hook and not
extractable, create a small helper test that replicates the computation logic:
```typescript
function computeMinimumOutput(toAmount: string, slippageBps: number): bigint {
  const amount = safeBigInt(toAmount)
  if (amount === 0n || slippageBps >= 10_000) return 0n
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n
}
```
Test this helper to document the edge cases, then add a comment referencing the
line in useSwap.ts where the real computation happens.

### Part B — CoW path validation tests

Add to the same test file or a separate `cow-swap-validations.test.ts`:

```
test: native ETH as tokenIn with cowswap source → throws "CoW Protocol does not support native ETH"
test: orderParams.receiver !== userAddress → throws "receiver does not match"
test: validTo > now + 1800s → clamped to now + 1800s (COW_MAX_ORDER_DURATION_SEC)
test: validTo within range → unchanged
```

**Implementation notes:**
- First, find the exact file paths for each validation function:
  ```bash
  grep -rn "export.*validateRouterAddress\|export.*validateCallDataRecipient\|export.*validateFeeIntegrity\|export.*isKnownSwapSelector\|export.*safeBigInt" src/lib/ src/hooks/
  ```
- Import directly from the source modules — no need to render the hook
- For A5, if the computation is inline, extract it into a testable helper in the
  test file (do NOT modify useSwap.ts)
- Use `describe` blocks per validation category (A1-A5, B)

**Do NOT:**
- Modify ANY production code
- Render the useSwap hook (too complex for this sprint — defer to Sprint 23)
- Add React testing dependencies beyond what's already in the project
- Change existing tests

**Files affected:**
- `src/hooks/__tests__/swap-validations.test.ts` (NEW)

**Quality criteria:**
- `npx vitest run src/hooks/__tests__/swap-validations.test.ts` → all pass
- `npm test` → all pass (~770+ total)
- `npx tsc --noEmit` clean
- Every security-critical validation has at least one positive and one negative test

---

## Prompt 133 — TransactionPreview Component Tests

**Context:** `src/components/TransactionPreview.tsx` (315 lines) is the "clear
signing" modal. It decodes calldata and displays recipient, amounts, deadline,
and minimum output before the user clicks "Confirm Swap". This is the user's
last visual check before signing.

Key logic:
- Recipient badge: `match` (green), `feecollector` (gold), `implicit` (grey),
  `other` (orange warning)
- Minimum output: "Enforced on-chain" badge when `routeViaFeeCollector && minimumOutput > 0n`
- Decode failure: yellow warning banner but confirm button stays active
- CoW: "Gasless" chip, "$0.00 (paid by solver)" gas row

**Objective:** Test the TransactionPreview component renders the correct security
indicators for various scenarios.

**Requirements:**

Create `src/components/__tests__/TransactionPreview.test.tsx`:

#### T1 — Recipient badge: user address match
```
setup: render with calldata where decoded recipient === userAddress
assert: green "Your wallet" badge visible
assert: no warning banner
```

#### T2 — Recipient badge: FeeCollector address
```
setup: render with decoded recipient === FEE_COLLECTOR_ADDRESS
assert: gold "FeeCollector" badge visible
```

#### T3 — Recipient badge: unknown address (attacker)
```
setup: render with decoded recipient === '0xattacker...'
assert: orange "Unknown" badge visible
assert: warning text visible (recipient does not match)
```

#### T4 — Recipient badge: implicit (msg.sender)
```
setup: render with decoded recipient === null (Group A selector)
assert: grey "msg.sender" or "implicit" badge visible
```

#### T5 — Minimum output: enforced on-chain
```
setup: render with routeViaFeeCollector=true, minimumOutput=1000000n (1 USDC)
assert: "Enforced on-chain" badge visible
assert: formatted amount displayed
```

#### T6 — Minimum output: zero (degraded)
```
setup: render with routeViaFeeCollector=true, minimumOutput=0n
assert: no minimum output row visible (silent degradation)
```

#### T7 — Decode failure
```
setup: render with calldata that fails decoding (e.g., '0xdeadbeef')
assert: yellow warning banner visible ("Could not decode" or similar)
assert: confirm button still active (not disabled)
assert: raw calldata section accessible
```

#### T8 — CoW gasless display
```
setup: render with source='cowswap'
assert: "Gasless" chip visible
assert: gas fee shows "$0.00" or "paid by solver"
```

#### T9 — Deadline display
```
setup: render with deadline = Date.now()/1000 + 300 (5 min from now)
assert: deadline shows "~5 min" or similar
setup: render with deadline = Date.now()/1000 - 60 (expired)
assert: deadline shows "Expired" or warning styling
```

**Implementation notes:**
- Use `@testing-library/react` (check if already installed: `grep -rn "@testing-library/react" package.json`)
- If not installed, install: `npm install -D @testing-library/react @testing-library/jest-dom`
- Mock `calldata-decoder.ts` to return controlled `DecodedPreview` objects
  rather than trying to construct valid calldata
- Mock wagmi hooks (`useAccount`, `useChainId`) to return test values
- The component likely needs a parent provider for wagmi — use a minimal
  test wrapper or mock the hooks directly via `vi.mock`
- Focus on what the user SEES (text content, badge presence) not internal state

**Do NOT:**
- Modify ANY production code
- Test the calldata-decoder itself (that's the validation functions in P132)
- Block on getting perfect visual rendering — focus on content assertions
- Add snapshot tests (fragile, not useful for security assertions)

**Files affected:**
- `src/components/__tests__/TransactionPreview.test.tsx` (NEW)

**Quality criteria:**
- `npx vitest run src/components/__tests__/TransactionPreview.test.tsx` → all pass
- `npm test` → all pass (~780+ total)
- `npx tsc --noEmit` clean
- Recipient badge logic has positive test for each of the 4 states
- Minimum output has test for both enforced and degraded (0n) paths

---

## Execution order

Both prompts on the same branch `test/frontend-security-hooks`:

1. P132 first (validation functions — no React rendering needed, lower risk of setup issues)
2. P133 second (component tests — may need React testing library setup)

One commit per prompt, one PR at the end.

## Post-sprint checklist

- [ ] All useSwap validation functions have positive + negative tests
- [ ] minimumOutput degradation to 0n is documented by test
- [ ] CoW path validations tested (ETH block, receiver check, validTo cap)
- [ ] TransactionPreview recipient badge has 4-state coverage
- [ ] Minimum output enforced vs degraded paths tested
- [ ] Decode failure shows warning but doesn't block confirm
- [ ] `npm test` passes with new tests included
- [ ] `npx tsc --noEmit` clean
- [ ] No production code changed
