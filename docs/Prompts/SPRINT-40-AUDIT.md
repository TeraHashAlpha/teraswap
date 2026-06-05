# Sprint 40 Audit — Security Hardening (Audit Follow-Up)

**Role:** You are a Senior Security Auditor reviewing Sprint 40 of the TeraSwap DEX aggregator. Your job is to verify the correctness of the security fixes, the new test coverage, and the cleanup changes.

**Branch:** `fix/sprint-40-security`  
**Base:** `main`  
**Commits:** 7 (P202 `c796bff`, P203 `370f148`, P204 `6d9592c`, P205 `25a8e57`, P206 `dcad548`, P202/P205 review `094afcd`, P204 review `386ab2b`)  
**Files changed:** API routes, hooks, components, lib modules, test files  
**Test count:** 1165 → 1195 (+30: 5 allowlist, 6 recipient/reset, 19 oracle)

**Risk level:** HIGH — touches order cancellation auth (fund-adjacent), approval flow (fund-critical), and calldata validation (defense-in-depth). The Code Agent ran an adversarial multi-agent review and found+fixed a HIGH regression (cancelAllOrders unsigned after P202 closed the unsigned PATCH path).

---

## Context

Sprint 40 closes 2 HIGH + 2 MEDIUM findings from the comprehensive audit (2026-05-28), adds 2 critical test gaps, and does cleanup. The Code Agent's adversarial self-review produced 2 additional fix commits.

| Prompt | Finding | Description |
|--------|---------|-------------|
| P202 | FULL-H-01 | Order cancellation required no ownership proof — now requires EIP-712 signature |
| P203 | FULL-H-02 | Approval spender trusted from API without allowlist — now validated client-side |
| P204 | FULL-M-01 + M-04 | Recipient over-permissive on direct routes + swap state not reset on account switch |
| P205 | TEST-H-01 + H-02 | Chainlink staleness + DefiLlama deviation — zero unit tests → 19 tests |
| P206 | INFO-01 + L-04 | Dead EIP-712 domains + stale CoW "infinite allowance" warning |

---

## Audit Checklist

### 1. P202 — EIP-712 Cancel Authentication (`c796bff` + `094afcd`)

#### API Route (`src/app/api/orders/[id]/route.ts`)

- [ ] **Signature required:** PATCH request body must include `signature` and `chainId` alongside `wallet`. Missing fields → 400.
- [ ] **Recovery:** `recoverTypedDataAddress` used with `CancelOrder` types (`{ id: string, action: 'cancel' }`). Domain from `getOrderExecutorDomain(chainId)`.
- [ ] **Comparison:** Recovered address (lowercased) compared to `wallet` (lowercased). Mismatch → 400.
- [ ] **Try/catch:** Malformed signature → 400, not 500.
- [ ] **No bypass:** Verify there is NO code path where a cancel goes through without signature verification.
- [ ] **Existing guards preserved:** The atomic `status = 'active'` → `status = 'cancelled'` update with `wallet` scoping is unchanged.

#### Frontend (`src/hooks/useOrderEngine.ts`)

- [ ] **Sign before cancel:** `cancelOrder` signs a `CancelOrder` EIP-712 message via `signTypedDataAsync` before calling the API.
- [ ] **Wallet rejection:** If user declines signature in wallet, the cancel is aborted gracefully (no crash, order not stuck in limbo).
- [ ] **cancelAllOrders fix (094afcd):** After P202 closed the unsigned PATCH path, `cancelAllOrders` was broken (got 400s silently). Verify it now signs per-order. Check if a failed individual signature skips that order without blocking the rest.

#### Config (`src/lib/order-engine/config.ts`)

- [ ] **`CANCEL_ORDER_TYPES`:** Defined with `{ id: 'string', action: 'string' }`. Exported.
- [ ] **Domain reuse:** Uses existing `getOrderExecutorDomain(chainId)` — NOT a new domain.

#### FEEDBACK items to verify

- [ ] **chainId from body (not server-derived):** The FEEDBACK notes this is spec-compliant but less secure than server-derived chainId. Verify the impact is bounded: recovered address must equal the order's wallet, `cancelled` is terminal/idempotent, only mainnet exists. **Assessment: INFO or LOW?**
- [ ] **No nonce/expiry in CancelOrder:** Replay of a cancel signature re-cancels the same order (idempotent). No cross-user impact. **Assessment: INFO?**

### 2. P203 — Spender Address Allowlist (`370f148`)

- [ ] **Trusted set defined:** `TRUSTED_SPENDER_ADDRESSES` built from router whitelist + FeeCollector V1/V2 + Permit2 + CoW vault relayer. All addresses lowercased. Set uses env vars (not hardcoded literals).
- [ ] **`isTrustedSpender(address)`:** Exported function, lowercases input before checking.
- [ ] **SwapBox validation:** Before setting `spender` state from API response, validates against `isTrustedSpender`. Untrusted → error message, spender NOT set.
- [ ] **useApproval defense-in-depth:** Before `writeExactApprove`, validates spender. Untrusted → throws (approval blocked).
- [ ] **Two layers:** Both SwapBox and useApproval validate independently — bypassing one doesn't bypass the other.
- [ ] **All current spenders included:** Verify the set includes all addresses that the swap flow legitimately approves to. Missing a legitimate spender = broken swaps.
- [ ] **Tests:** Check for allowlist validation tests (5 expected per Code Agent).

### 3. P204 — Recipient Validation + Swap Reset (`6d9592c` + `386ab2b`)

#### Recipient validation (FULL-M-01)

- [ ] **`isValidRecipient` parameterized:** Accepts `routeViaFeeCollector` boolean. When `false`, FeeCollector addresses are NOT in the valid set.
- [ ] **Callers pass correct value:** `useSwap.ts`, `useSplitSwap.ts`, and `api/swap/route.ts` pass `routeViaFeeCollector` based on whether the route actually goes through FeeCollector.
- [ ] **Direct routes reject FeeCollector:** A swap to a FEE_INCOMPATIBLE source with recipient = FeeCollector address → blocked.
- [ ] **Fee routes still accept FeeCollector:** Normal fee-routed swaps unchanged.
- [ ] **Existing tests pass:** `calldata-recipient.test.ts` tests adapted (not broken).
- [ ] **New tests:** At least 2 new tests (direct route rejection + fee route acceptance).

#### Swap state reset (FULL-M-04)

- [ ] **Reset on address change:** `useEffect` keyed on `address` clears `pendingSwap`, `status`, `errorMessage`, `cowOrderUid`, `txHashState` (or equivalent).
- [ ] **Reset on disconnect:** `!address` also triggers reset.
- [ ] **No reset on initial connect:** First connection (no previous address) does NOT spuriously clear state.
- [ ] **Ref comparison:** Uses `prevAddressRef` or similar to detect actual change vs re-render.
- [ ] **New tests (386ab2b):** 3 tests covering switch, disconnect, no-reset-on-initial.

### 4. P205 — Oracle/Price-Guard Tests (`25a8e57` + `094afcd`)

#### `src/lib/chainlink.test.ts`

- [ ] **Stale round test:** `answeredInRound < roundId` → returns `null`.
- [ ] **Expired data test:** `updatedAt` beyond `CHAINLINK_MAX_STALENESS_SEC` → returns `null`.
- [ ] **Zero answer test:** `answer = 0n` → returns `null`.
- [ ] **Negative answer test:** `answer < 0` → returns `null`.
- [ ] **Valid round test:** All checks pass → returns `{ price, updatedAt, roundId }`.
- [ ] **Decimal decoding tests:** 8-decimal and 18-decimal feeds produce correct float prices.
- [ ] **RPC failure test:** Error propagation verified (caller handles gracefully).
- [ ] **Staleness boundary test pinned (094afcd):** `Date.now()` pinned to prevent clock race flake.

#### `src/lib/defillama.test.ts`

- [ ] **Normal deviation:** ~2% negative → `valid: true, blocked: false`.
- [ ] **>8% deviation block:** -9% → `valid: false, blocked: true`.
- [ ] **Exact -8% boundary (strict):** Exactly -8% is NOT blocked (deviation < -0.08 is strict `<`).
- [ ] **Missing oracle, small swap:** → `null` (fail-open).
- [ ] **Missing oracle, high-value swap:** → `blocked: true` (fail-closed).
- [ ] **Calculation error, small swap:** → `null`.
- [ ] **Calculation error, high-value swap:** → `blocked: true`.
- [ ] **Decimal math:** Realistic WETH/USDC with 18/6 decimal asymmetry.
- [ ] **Tests mock at correct level:** Mocking `fetchDefiLlamaPrice`, not the HTTP layer.

#### FEEDBACK item

- [ ] **Low-confidence branch unreachable (dead code):** `fetchDefiLlamaPrice` returns `null` for confidence < 0.5, so `validateSwapPrice` never sees a low-confidence price object. The tests cover the fail-open/closed behaviour via the missing-oracle path. **Assessment: INFO (dead code, no security impact)?**

### 5. P206 — Cleanup (`dcad548`)

- [ ] **Dead domains removed:** `PERMIT2_DOMAIN` from `approvals.ts` and deprecated `ORDER_EXECUTOR_DOMAIN` from `config.ts` removed. No remaining imports.
- [ ] **`getOrderExecutorDomain(chainId)` preserved:** The live dynamic function is NOT removed.
- [ ] **CoW allowance warning removed:** The "infinite allowance" warning UI and associated state (`method:'infinite'`, `needsRevoke:true`) removed. CoW path now correctly reflects exact approvals.
- [ ] **No test breakage:** No test asserted the removed warning UI.
- [ ] **Grep clean:** No references to `PERMIT2_DOMAIN` or deprecated `ORDER_EXECUTOR_DOMAIN` remain.

### 6. General

- [ ] **No scope creep:** Changes limited to the specified files.
- [ ] **No new dependencies:** No npm packages added.
- [ ] **FEEDBACK.md reviewed:** Code Agent documented deviations and review findings. All items triaged in this audit.
- [ ] **TypeScript:** `npm run typecheck` must pass.
- [ ] **Lint:** `npm run lint` must pass.
- [ ] **All tests:** `npm run test` must pass with 0 failures. Report actual test count.

---

## Expected Output

```markdown
## Sprint 40 Audit Verdict

**Branch:** fix/sprint-40-security
**Commits reviewed:** c796bff, 370f148, 6d9592c, 25a8e57, dcad548, 094afcd, 386ab2b
**Tests:** 1165 → {actual count}

### Verdict: {APPROVED | APPROVED WITH WARNINGS | REJECTED}

{0C / 0H / 0M / 0L / NI INFO}

### Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 40-{severity}-{NN} | {C/H/M/L/INFO} | {file} | {description} |

### Comprehensive Audit Findings Closure

| Finding | Status | Verified |
|---------|--------|----------|
| FULL-H-01 (cancel no auth) | {CLOSED/OPEN} | {✅/❌} |
| FULL-H-02 (spender allowlist) | {CLOSED/OPEN} | {✅/❌} |
| FULL-M-01 (recipient over-permissive) | {CLOSED/OPEN} | {✅/❌} |
| FULL-M-04 (swap state reset) | {CLOSED/OPEN} | {✅/❌} |
| FULL-L-04 (CoW warning stale) | {CLOSED/OPEN} | {✅/❌} |
| INFO-01 (dead domains) | {CLOSED/OPEN} | {✅/❌} |
| TEST-H-01 (chainlink tests) | {CLOSED/OPEN} | {✅/❌} |
| TEST-H-02 (defillama tests) | {CLOSED/OPEN} | {✅/❌} |

### FEEDBACK Deviations

| # | Item | Auditor Assessment |
|---|------|-------------------|
| 1 | chainId from body, not server-derived | {Accept / Flag / Fix required} |
| 2 | No nonce/expiry in CancelOrder | {Accept / Flag / Fix required} |
| 3 | cancelAllOrders signs per-order | {Accept / Flag / Fix required} |
| 4 | DefiLlama low-confidence branch dead code | {Accept / Flag / Fix required} |
| 5 | BLOCK_THRESHOLD not exported | {Accept / Flag / Fix required} |
| 6 | CoW warning fully removed (not just disabled) | {Accept / Flag / Fix required} |

### Recommendation

{Merge / Fix required / ...}
```

Run `npm run typecheck`, `npm run lint`, and `npm run test` before delivering the verdict. Report the actual test count.
