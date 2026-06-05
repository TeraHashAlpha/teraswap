# Sprint 6A — Smart Contract Pre-Launch Blockers

**Sprint window:** 2026-04-15 → TBD
**Sprint goal:** Address all CRITICAL + HIGH smart contract findings from the comprehensive post-5C audit before mainnet deployment.
**Owner:** TeraHash (founder/architect) + code agent
**Audit report:** `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx`

---

## Audit finding validation

Before writing prompts, the Architect cross-referenced each finding against the current codebase. **2 of 4 findings are already resolved in code:**

| # | Finding | Audit severity | Code status | Action |
|---|---------|---------------|-------------|--------|
| SC-C-01 | routerDataHash bypass (bytes32(0)) | CRITICAL | **ALREADY FIXED** — line 400 of OrderExecutor: `if (order.routerDataHash == bytes32(0)) revert RouterDataMismatch()`. Comment `[MEDIUM-006]` confirms prior audit fix. DCA bypass is intentional (calldata varies per execution). | Prompt 36: verify + harden DCA path |
| SC-H-03 | Reentrancy via fee transfer before router call | HIGH | **ALREADY MITIGATED** — `nonReentrant` modifier on `executeOrder()` (line 373), contract inherits `ReentrancyGuard` (line 62). Fee→router order is safe under reentrancy guard. | Prompt 36: verify + add test |
| SC-H-01 | setExecutor() lacks timelock | HIGH | **CONFIRMED OPEN** — lines 766-771: immediate admin change, no timelock. | Prompt 37 |
| SC-H-02 | ETH receive() fallback silently accepts ETH | HIGH | **CONFIRMED OPEN** — line 270 FeeCollector + line 921 OrderExecutor: empty `receive() external payable {}`. | Prompt 38 |

**Net sprint scope:** 3 prompts instead of 4 full rewrites. SC-C-01 and SC-H-03 need verification + hardening, not from-scratch fixes.

---

## Prompt 36 — Verify SC-C-01 + SC-H-03 and harden DCA routerDataHash path

**Status:** Pending.

**Context:** The comprehensive audit flagged SC-C-01 (routerDataHash bypass, CRITICAL) and SC-H-03 (reentrancy, HIGH). Code review reveals both were already addressed in prior sprints:

- **SC-C-01:** `TeraSwapOrderExecutor.sol` line 397-403 already rejects `bytes32(0)` for non-DCA orders. The `[MEDIUM-006]` comment confirms this was a prior audit fix. However, **DCA orders still allow `bytes32(0)`** — this is intentional because the executor generates fresh calldata per DCA execution, so the user can't pre-commit to a hash. The auditor may have flagged the DCA path as the remaining risk.

- **SC-H-03:** `ReentrancyGuard` is inherited (line 62) and `nonReentrant` is applied to `executeOrder()` (line 373). The fee transfer before router call is protected.

**Objective:** Validate that both mitigations are complete, harden the DCA path, and add explicit tests proving the protections work.

**Requirements:**

1. **DCA routerDataHash hardening** — the DCA path allows `bytes32(0)` because calldata varies per execution. However, we should add a secondary validation:
   - After the router call (line 470), verify that `order.owner` received the output tokens. Compare `balanceAfter - balanceBefore >= order.minAmountOut`. This is the existing slippage check — confirm it runs for ALL order types including DCA.
   - If the `minAmountOut` check is missing for DCA, add it. The `minAmountOut` is the user's protection against calldata manipulation when `routerDataHash` is `bytes32(0)`.
   - Add a NatSpec comment at the DCA bypass explaining why `bytes32(0)` is safe: "DCA orders: routerDataHash bypass is safe because (a) minAmountOut enforces minimum output, (b) recipient is always order.owner (verified at line N), (c) nonReentrant prevents compound attacks."

2. **Recipient validation for DCA** — verify that the recipient of the swap output is ALWAYS `order.owner`, not an arbitrary address from `routerData`. If the router calldata can specify a different recipient, this is the actual SC-C-01 vector. Check:
   - Does the executor validate that swap output goes to `order.owner`?
   - Or does the executor trust the router calldata to send to the right address?
   - If the latter, add a `balanceOf(order.owner)` before/after check to enforce recipient.

3. **Reentrancy guard verification test:**
   - Add a test that attempts reentrancy during `executeOrder()` — use a mock ERC-20 token with a `transfer` hook that calls `executeOrder()` again. Verify it reverts with `ReentrancyGuardReentrantCall`.
   - Add a test confirming `nonReentrant` is on `executeOrder()`.

4. **SC-C-01 verification tests:**
   - Test: non-DCA order with `routerDataHash = bytes32(0)` → reverts `RouterDataMismatch`. (May already exist.)
   - Test: non-DCA order with wrong `routerDataHash` → reverts `RouterDataMismatch`.
   - Test: DCA order with `bytes32(0)` → succeeds IF `minAmountOut` is met.
   - Test: DCA order with `bytes32(0)` but output < `minAmountOut` → reverts.

**Files affected:**
- `contracts/order-engine/TeraSwapOrderExecutor.sol` (NatSpec comments, potentially add balance check)
- `test/` (new tests for reentrancy + routerDataHash verification)

**Do NOT:**
- Do NOT change the existing `bytes32(0)` rejection for non-DCA orders — it's correct.
- Do NOT remove the DCA `bytes32(0)` bypass — it's architecturally necessary.
- Do NOT change the fee transfer order (fee before router) — it's safe under nonReentrant.
- Do NOT add a second reentrancy guard — one is sufficient.

**Quality criteria:**
- All existing tests pass (22/22 + new tests).
- NatSpec comments explain the security model for the DCA path.
- Reentrancy test proves the guard works.
- `routerDataHash` tests cover all 4 scenarios above.
- `forge build` clean. `forge test` all green.

---

## Prompt 37 — Add timelock to setExecutor() (SC-H-01)

**Status:** Pending.

**Context:** `setExecutor()` (lines 766-771) allows the admin to instantly whitelist or remove executor addresses. Other privileged operations have timelocks: `ROUTER_CHANGE` = 48h, `ADMIN_TRANSFER` = 7d, `SWEEP` = 48h. The executor role is highly privileged — a whitelisted executor can call `executeOrder()` for any user's signed orders. Instantly swapping the executor address bypasses the timelock protections on other operations.

**Objective:** Apply a timelock to `setExecutor()` consistent with the existing timelock pattern.

**Requirements:**

1. **Add timelock to `setExecutor()`** following the existing pattern used for `proposeRouter()` / `executeRouter()`:
   - `proposeExecutor(address executor, bool status)` — records the proposal with a `EXECUTOR_CHANGE_DELAY` (48h, matching `ROUTER_CHANGE`).
   - `executeExecutorChange(address executor)` — applies the change after the delay has elapsed.
   - `cancelExecutorProposal(address executor)` — cancels a pending proposal.
   - Grace period: 7 days (matching `GRACE_PERIOD` used elsewhere). If not executed within delay + grace, the proposal expires.

2. **Events:**
   - `ExecutorChangeProposed(address indexed executor, bool status, uint256 executeAfter)`
   - `ExecutorChangeExecuted(address indexed executor, bool status)`
   - `ExecutorChangeCancelled(address indexed executor)`

3. **Storage:**
   - Add mapping for pending executor proposals: `mapping(address => ExecutorProposal) public pendingExecutorChanges`
   - Struct: `struct ExecutorProposal { bool proposed; bool newStatus; uint256 executeAfter; }`

4. **Constant:** `uint256 public constant EXECUTOR_CHANGE_DELAY = 48 hours;`

5. **Bootstrap exception:** During initial deployment, the first N executor additions may need to bypass the timelock (similar to how `setRouter` might work during bootstrap). If a bootstrap mechanism exists, apply it here. If not, the timelock applies from the first call.

6. **Tests:**
   - Propose → wait 48h → execute: succeeds.
   - Propose → execute immediately: reverts `TimelockNotExpired`.
   - Propose → wait 48h + 7d + 1s → execute: reverts `ProposalExpired`.
   - Propose → cancel → execute: reverts `NoActiveProposal`.
   - Non-admin calls propose: reverts `NotAdmin`.

**Files affected:**
- `contracts/order-engine/TeraSwapOrderExecutor.sol` (replace `setExecutor()` with propose/execute/cancel pattern)
- `test/` (new timelock tests)

**Do NOT:**
- Do NOT change the existing router or admin timelock patterns — only add the executor one.
- Do NOT remove the `ExecutorWhitelisted` event — keep it in the `executeExecutorChange()` function.
- Do NOT change the `whitelistedExecutors` mapping type — it stays `mapping(address => bool)`.

**Quality criteria:**
- All existing tests updated to use propose→mine→execute pattern.
- New timelock tests pass.
- `EXECUTOR_CHANGE_DELAY` matches `ROUTER_CHANGE` delay (48h).
- `forge build` clean. `forge test` all green.

---

## Prompt 38 — Fix ETH receive() fallback (SC-H-02)

**Status:** Pending.

**Context:** Both `TeraSwapOrderExecutor.sol` (line 921) and `TeraSwapFeeCollector.sol` (line 270) have empty `receive() external payable {}` functions that silently accept any ETH. The FeeCollector's `receive()` has a NatSpec comment saying "Accept ETH from routers (e.g. WETH unwrap, partial refunds)" — so it has a legitimate use case during swaps. The OrderExecutor's `receive()` may also be needed for WETH unwraps.

The risk: failed fee transfers or accidental ETH sends are silently swallowed. ETH can accumulate in the contracts without any way for the admin to notice or act.

**Objective:** Make ETH handling explicit — accept ETH only during swap execution, revert otherwise. Ensure sweep functions cover stuck ETH.

**Requirements:**

1. **FeeCollector — restrict receive() to active swap context:**
   - The `receive()` is needed during `swapETHWithFee()` and `swapTokenWithFee()` (for router refunds). These functions already have `nonReentrant`.
   - Option A (preferred): Add a `_inSwap` flag that is set during swap functions. `receive()` reverts if `_inSwap` is false. This prevents accidental ETH deposits outside of swaps.
   - Option B (simpler): Keep `receive()` open but add an event `ETHReceived(address sender, uint256 amount)` for monitoring.
   - The existing `sweep(address(0))` function handles stuck ETH — verify it works correctly.

2. **OrderExecutor — same approach:**
   - Check if `receive()` is needed (WETH unwraps during order execution). If yes, restrict to `_inSwap` context.
   - If `receive()` is NOT needed in OrderExecutor (orders use ERC-20 only), remove it entirely or add `revert()`.
   - The OrderExecutor has a `sweep()` function (lines 714-759) with a 48h timelock — verify it handles ETH.

3. **Sweep verification:**
   - Test: ETH sent to FeeCollector during swap → accepted.
   - Test: ETH sent to FeeCollector outside swap → reverted (Option A) or event emitted (Option B).
   - Test: `sweep(address(0))` on FeeCollector sends ETH to feeRecipient.
   - Test: `sweep(address(0))` on OrderExecutor sends ETH (if applicable).

4. **Event for monitoring (both contracts):**
   - If `receive()` stays open, add `event ETHReceived(address indexed sender, uint256 amount)` to enable off-chain monitoring of unexpected deposits.

**Files affected:**
- `contracts/fee-collector/TeraSwapFeeCollector.sol` (modify `receive()`, add flag or event)
- `contracts/order-engine/TeraSwapOrderExecutor.sol` (modify `receive()`, add flag or event)
- `test/` (new tests for ETH handling)

**Do NOT:**
- Do NOT break the swap flow — `receive()` MUST work during active swaps (router refunds).
- Do NOT add a separate ETH withdrawal function — use the existing `sweep()`.
- Do NOT change the `sweep()` timelock — it's correctly at 48h.

**Quality criteria:**
- All existing swap tests pass (ETH paths work correctly).
- New tests for `receive()` restriction.
- Sweep tests for ETH recovery.
- `forge build` clean. `forge test` all green.

---

## Auditor review — Sprint 6A

**Scope:** Review all changes from Prompts 36, 37, 38.

**Checklist:**

1. **SC-C-01 (routerDataHash):**
   - [ ] Non-DCA `bytes32(0)` rejection still in place
   - [ ] DCA path has `minAmountOut` enforcement
   - [ ] DCA path has recipient validation (output goes to `order.owner`)
   - [ ] NatSpec explains security model
   - [ ] Reentrancy test proves guard works
   - [ ] All 4 routerDataHash test scenarios pass

2. **SC-H-01 (setExecutor timelock):**
   - [ ] `proposeExecutor` / `executeExecutorChange` / `cancelExecutorProposal` implemented
   - [ ] 48h delay matches `ROUTER_CHANGE`
   - [ ] 7d grace period matches existing pattern
   - [ ] Events emitted for all lifecycle steps
   - [ ] All 5 timelock test scenarios pass
   - [ ] Existing tests updated for new flow

3. **SC-H-02 (ETH receive):**
   - [ ] `receive()` restricted to swap context or event-monitored
   - [ ] Swap ETH paths still work (no regression)
   - [ ] `sweep(address(0))` correctly recovers stuck ETH
   - [ ] Tests cover accept-during-swap + reject-outside-swap

4. **SC-H-03 (reentrancy):**
   - [ ] `nonReentrant` confirmed on `executeOrder()`
   - [ ] Reentrancy test with mock malicious token
   - [ ] No new reentrancy vectors introduced by other changes

5. **Cross-cutting:**
   - [ ] No storage layout collisions from new mappings/structs
   - [ ] Gas impact acceptable (timelock adds ~2 SLOAD per executor check)
   - [ ] All existing 22+ tests still pass
   - [ ] `forge build` clean, `forge test` all green

**Expected output:** Findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## See also

- Comprehensive audit report: `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx`
- ADR-001 § monitoring architecture (related to API-C-01, addressed in Sprint 6B)
- Sprint 6B: API auth + monitoring hardening (API-C-01, API-H-01 through API-H-04)
- Sprint 6C: Medium priority fixes (API-M-01 through API-M-04, FE-M-01, FE-M-02)
- Sprint 6D: Hardening (FE-L-01, API-L-01)
