# TeraSwapOrderExecutor v2 - Smart Contract Security Audit Report

**Audit Date:** March 5, 2026
**Contract:** TeraSwapOrderExecutor v2
**Version:** Solidity 0.8.20
**Auditor:** Security Analysis Team
**Status:** Complete (4-Phase Methodology)

---

## Executive Summary

TeraSwapOrderExecutor v2 is a sophisticated order execution protocol enabling users to sign conditional swap orders (Limit, Stop-Loss, DCA) off-chain via EIP-712, with execution delegated to Gelato Automate. The contract implements multiple security hardening measures from v1, including router whitelisting with timelock, nonce invalidation, and Chainlink oracle validation.

**Overall Risk Assessment: MEDIUM**

### Key Findings

- **3 Critical Issues:** None identified
- **2 High Issues:** None confirmed (mitigated by SafeERC20)
- **3 Medium Issues:** Fee precision loss, DCA amount splitting truncation, race condition in timelock
- **5 Low Issues:** Best practices, gas efficiency, input validation gaps
- **2 Informational:** Code quality suggestions

The contract demonstrates strong security fundamentals with proper use of OpenZeppelin libraries, rereentrancy protection, and comprehensive state validation. However, precision loss in fee/DCA calculations and a subtle timelock race condition warrant attention before mainnet deployment.

### Critical Mitigations Confirmed

✅ Router substitution prevented (H-01: router in signed hash)
✅ ETH output handling implemented with fallback (H-02)
✅ Nonce invalidation + per-order cancellation (H-03)
✅ Signature validation via EIP-712 (ECDSA.recover + domain separator)
✅ Chainlink staleness + incomplete round checks
✅ ReentrancyGuard on executeOrder
✅ SafeERC20 for all token transfers

---

## Findings Summary Table

| ID | Title | Severity | Confidence | Category | Status |
|---|---|---|---|---|---|
| M-01 | Fee Precision Loss (Rounding Down) | Medium | High | Arithmetic | Open |
| M-02 | DCA Amount Truncation Under Multiple Executions | Medium | High | Arithmetic | Open |
| M-03 | Timelock Race Condition with Block.timestamp | Medium | Medium | Logic | Open |
| L-01 | Weak Input Validation in invalidateNonces() | Low | High | Input Validation | Open |
| L-02 | Missing Event Emission in executeAdminChange & executeRouterChange | Low | Medium | Events | Open |
| L-03 | Inefficient Comparison in _checkPriceCondition | Low | Low | Gas Efficiency | Open |
| L-04 | No Validation for dcaTotal == 0 | Low | Medium | Edge Case | Open |
| L-05 | Bootstrap Router Validation Not Enforced | Low | Low | Best Practice | Open |
| I-01 | EIP-712 Domain Name Hardcoded | Informational | Medium | Code Quality | Open |
| I-02 | Missing Natspec for Internal Functions | Informational | Low | Documentation | Open |

---

## Detailed Findings

### M-01: Fee Precision Loss (Rounding Down)

**Severity:** Medium
**Confidence:** High
**Location:** Line 358
**Category:** Arithmetic Precision

#### Description

The fee calculation rounds down due to integer division:
```solidity
uint256 fee = (executeAmount * FEE_BPS) / BPS_DENOMINATOR;
```

With `FEE_BPS = 10` and `BPS_DENOMINATOR = 10_000`, small amounts lose precision:
- `executeAmount = 1` wei → `fee = (1 * 10) / 10_000 = 0` wei (should be 0.001 wei)
- `executeAmount = 999` wei → `fee = (999 * 10) / 10_000 = 0` wei
- `executeAmount = 1_000` wei → `fee = 1` wei (correct)

#### Attack Scenario

While protocol-side loss is minimal, the asymmetry creates:
1. **Users:** Can submit many micro-orders (< 1,000 wei) with zero fees
2. **Accumulation:** Thousands of tiny orders → significant lost fees
3. **MEV Opportunity:** Bots batch micro-orders to exploit rounding

Example: 10,000 orders of 500 wei each:
- Expected fees: 10,000 × 0.5 wei = 5,000 wei
- Actual fees: 10,000 × 0 wei = 0 wei
- **Loss: 5,000 wei per batch**

#### Impact

- Reduced protocol revenue over time
- Economically irrational order sizes create spam vector
- Compounds with DCA (see M-02)

#### Recommendation

Implement rounding-up fee calculation or minimum order enforcement:

**Option A: Always round up fees**
```solidity
uint256 fee = (executeAmount * FEE_BPS + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
```

**Option B: Enforce minimum order size**
```solidity
if (executeAmount < 1_000) revert MinimumOrderSizeNotMet();
```

**Option C: Accumulate fractional fees** (more complex)
```solidity
mapping(address => uint256) fractionalFees;
fractionalFees[owner] += (executeAmount * FEE_BPS) % BPS_DENOMINATOR;
```

---

### M-02: DCA Amount Truncation Under Multiple Executions

**Severity:** Medium
**Confidence:** High
**Location:** Lines 280, 337, 381
**Category:** Arithmetic Precision

#### Description

DCA orders split the total amount by dividing by `dcaTotal`. Integer division truncates:

```solidity
// Line 280 (canExecute check)
uint256 requiredAmount = order.amountIn / order.dcaTotal;

// Line 337 (executeOrder)
executeAmount = order.amountIn / order.dcaTotal;

// Line 381 (output check)
uint256 minOut = order.minAmountOut / order.dcaTotal;
```

**Example scenario:**
```
amountIn = 1_000 wei
dcaTotal = 3 executions
Per-execution = 1_000 / 3 = 333 wei (truncated from 333.33)
Total executed = 333 × 3 = 999 wei
Lost = 1 wei
```

For larger amounts:
```
amountIn = 1_000_000_000 wei (10^9)
dcaTotal = 7
Per-execution = 142_857_142 wei (truncated from 142_857_142.857...)
Total executed = 999_999_994 wei
Lost = 6 wei
```

#### Attack Scenario

An attacker can craft DCA orders that systematically leak dust:

1. Create 100 DCA orders with `amountIn = 10^18`, `dcaTotal = 7`
2. Each order loses `(10^18 % 7) = 6 wei` per total execution
3. Over 100 orders: 600 wei leaked
4. Compounds if no dust refund sweep

Additionally, there's a **state sync issue**: The dust refund at line 422-425 refunds leftover *input tokens*, but:
- This only captures dust if the router doesn't consume all inputs
- It doesn't recover the ceiling loss from division

#### Impact

- Lost user funds accumulate across DCA orders
- Particularly damaging for small dcaTotal values (3-7 very common)
- No mechanism to recover truncated amounts
- Violates expected DCA semantics ("execute N times total amount")

#### Recommendation

Implement cumulative tracking or enforce divisibility:

**Option A: Cumulative DCA tracking (recommended)**
```solidity
struct DCAState {
    uint256 totalExecuted;  // Track cumulative amount
    uint256 lastExecution;  // timestamp
}
mapping(bytes32 => DCAState) public dcaState;

function executeOrder(...) {
    uint256 totalPerExecution = order.amountIn / order.dcaTotal;
    uint256 cumulativeAmount = totalPerExecution * (dcaExecutions[orderHash] + 1);
    uint256 remainingAmount = order.amountIn - dcaState[orderHash].totalExecuted;

    // Use remaining amount for final execution to recover dust
    uint256 executeAmount = (dcaExecutions[orderHash] == order.dcaTotal - 1)
        ? remainingAmount
        : totalPerExecution;

    dcaState[orderHash].totalExecuted += executeAmount;
}
```

**Option B: Enforce divisibility at order creation**
```solidity
// In canExecute / executeOrder
if (order.amountIn % order.dcaTotal != 0) {
    revert DCATotalMustDivideEvenly();
}
```

**Option C: Use WAD accounting** (avoid truncation)
```solidity
uint256 WAD_PRECISION = 10^18;
uint256 perExecution = (order.amountIn * WAD_PRECISION) / order.dcaTotal;
uint256 actualAmount = perExecution / WAD_PRECISION;
```

---

### M-03: Timelock Race Condition with Block.timestamp

**Severity:** Medium
**Confidence:** Medium
**Location:** Lines 475-490, 494-509, 515-530, 534-551
**Category:** Logic / Timing

#### Description

The timelock implementation has a subtle race condition where an attacker can queue and execute a state change within the same block under specific circumstances.

**Vulnerable code pattern:**
```solidity
// Line 480
bytes32 actionId = keccak256(abi.encode(actionHash, block.timestamp));

// Lines 484-488
timelockActions[actionId] = TimelockAction({
    actionHash: actionHash,
    readyAt: block.timestamp + TIMELOCK_DELAY,  // 48 hours
    exists: true
});

// Line 499
if (block.timestamp < action.readyAt) revert TimelockNotReady();
```

**The Issue:**
The `actionId` is derived from `block.timestamp` at queue time. While the delay (48 hours) prevents immediate execution, there's no validation preventing:

1. **Duplicate queue calls in same block:** If admin calls `queueRouterChange` twice with identical parameters in the same block:
   - Both generate the same `actionId` (same block.timestamp)
   - Second call reverts with `TimelockAlreadyQueued()`
   - This is correct behavior, but...

2. **Block-timestamp manipulation edge case:** In the execute functions, the check is:
   ```solidity
   if (block.timestamp < action.readyAt) revert TimelockNotReady();
   ```

   If queued at block timestamp `T`:
   - `readyAt = T + 48 hours`
   - Can execute at any block with timestamp ≥ `T + 48 hours`
   - **No upper bound** on when it can execute (unlike Compound timelock)

3. **State manipulation between queue and execute:**
   ```solidity
   bytes32 expectedHash = keccak256(abi.encode("setRouter", router, status));
   if (action.actionHash != expectedHash) revert TimelockHashMismatch();
   ```

   The contract re-computes the hash to prevent parameter swapping. However, there's no temporal validation that the action hasn't been sitting queued for excessively long (e.g., years).

#### Attack Scenario

**Scenario 1: MEV in 48-hour window**
1. Admin queues: `setRouter(maliciousRouter, true)` at block T
2. Block T + 48 hours arrives
3. Admin's execute transaction is in mempool
4. Attacker front-runs with another router change, blocking execution

**Scenario 2: Delayed execution exploitation**
1. Admin queues router change year ago
2. Contracts in ecosystem evolved, trusted assumptions changed
3. Old timelock action suddenly executes without recent governance review
4. No "freshness" check on the queued action

#### Impact

- **Low probability** but **high impact** if exploited
- Breaks "explicit delayed change" semantics
- No way to cancel expired or stale timelock actions (except manual cancel)
- MEV operators could front-run critical admin changes

#### Recommendation

Add temporal bounds to timelock execution:

**Option A: Max execution window (recommended)**
```solidity
uint256 public constant MAX_EXECUTION_WINDOW = 1 weeks;

function executeRouterChange(bytes32 actionId, address router, bool status) external {
    TimelockAction storage action = timelockActions[actionId];
    if (!action.exists) revert TimelockNotQueued();
    if (block.timestamp < action.readyAt) revert TimelockNotReady();
    if (block.timestamp > action.readyAt + MAX_EXECUTION_WINDOW) {
        revert TimelockExpired();  // Must execute within 1 week window
    }
    // ... rest of execution
}
```

**Option B: Track queue timestamp explicitly**
```solidity
struct TimelockAction {
    bytes32 actionHash;
    uint256 readyAt;
    uint256 queuedAt;  // NEW: when was it queued
    bool exists;
}

function executeRouterChange(bytes32 actionId, address router, bool status) external {
    TimelockAction storage action = timelockActions[actionId];
    uint256 ageInSeconds = block.timestamp - action.queuedAt;
    if (ageInSeconds > 180 days) {  // Must execute within 6 months
        revert TimelockTooOld();
    }
}
```

---

### L-01: Weak Input Validation in invalidateNonces()

**Severity:** Low
**Confidence:** High
**Location:** Line 456
**Category:** Input Validation

#### Description

The `invalidateNonces()` function uses `require()` instead of a custom error:

```solidity
function invalidateNonces(uint256 newNonce) external {
    require(newNonce > invalidatedNonces[msg.sender], "Must increase");
    invalidatedNonces[msg.sender] = newNonce;
    emit NoncesInvalidated(msg.sender, newNonce);
}
```

**Issues:**
1. Uses string-based error (higher gas cost, larger bytecode)
2. No explicit revert selector for programmatic error handling
3. Inconsistent with other functions that use custom errors
4. No upper bound validation (user could set nonce to `type(uint256).max`)

#### Impact

- Inconsistent error handling
- Slightly higher gas cost
- User could set `invalidatedNonces[user] = type(uint256).max`, permanently blocking all orders

#### Recommendation

**Replace with custom error and validation:**
```solidity
error InvalidNonceValue();

function invalidateNonces(uint256 newNonce) external {
    uint256 current = invalidatedNonces[msg.sender];
    if (newNonce <= current) revert InvalidNonceValue();

    // Optional: prevent nonsensical values
    uint256 userNonce = nonces[msg.sender];
    if (newNonce > userNonce + 1000) revert InvalidNonceValue();

    invalidatedNonces[msg.sender] = newNonce;
    emit NoncesInvalidated(msg.sender, newNonce);
}
```

---

### L-02: Missing Event Emission in Admin Execution Functions

**Severity:** Low
**Confidence:** Medium
**Location:** Lines 494-509, 534-551
**Category:** Events / Monitoring

#### Description

The `executeRouterChange()` and `executeAdminChange()` functions emit `TimelockExecuted` but lack descriptive event details:

```solidity
function executeRouterChange(bytes32 actionId, address router, bool status) external {
    // ... validation ...
    delete timelockActions[actionId];
    whitelistedRouters[router] = status;

    emit TimelockExecuted(actionId);  // Only actionId, no action details!
    emit RouterWhitelisted(router, status);  // This is good
}

function executeAdminChange(bytes32 actionId, address newAdmin) external {
    // ... validation ...
    delete timelockActions[actionId];
    address oldAdmin = admin;
    admin = newAdmin;

    emit TimelockExecuted(actionId);  // Only actionId
    emit AdminTransferred(oldAdmin, newAdmin);  // This is good
}
```

**Issue:** The `TimelockExecuted` event only contains `actionId`, making it difficult to track which action was executed without off-chain decoding.

#### Impact

- Monitoring tools must store all queued actions to understand what executed
- Harder to audit critical admin actions from event logs alone
- Inconsistent event design (some have details, some don't)

#### Recommendation

**Enhance TimelockExecuted event with action details:**
```solidity
event TimelockExecuted(
    bytes32 indexed actionId,
    string indexed actionType,  // "setRouter" | "setAdmin"
    bytes data  // abi.encode(router, status) or abi.encode(newAdmin)
);

function executeRouterChange(bytes32 actionId, address router, bool status) external {
    // ... validation ...
    delete timelockActions[actionId];
    whitelistedRouters[router] = status;

    emit TimelockExecuted(actionId, "setRouter", abi.encode(router, status));
    emit RouterWhitelisted(router, status);
}
```

---

### L-03: Inefficient Comparison in _checkPriceCondition

**Severity:** Low
**Confidence:** Low
**Location:** Line 617
**Category:** Gas Efficiency

#### Description

The `_checkPriceCondition()` function checks `price <= 0` but Chainlink prices are `int256`:

```solidity
if (price <= 0) return (false, "Invalid price");
```

This is inefficient because:
1. Checks for exact equality and less-than separately
2. Could be optimized to `price < 1` (prices < 1 wei are invalid)
3. Negative prices are extremely unlikely in practice for asset price feeds

#### Impact

- Minimal gas cost difference (1-2 gas)
- Mostly a code quality issue
- The check is correct, just inelegant

#### Recommendation

**Minor optimization (optional):**
```solidity
if (price < 1) return (false, "Invalid price");
```

Or add explicit comment explaining the check:
```solidity
// Chainlink prices should be positive; reject zero or negative
if (price <= 0) return (false, "Invalid price");
```

---

### L-04: No Validation for dcaTotal == 0

**Severity:** Low
**Confidence:** Medium
**Location:** Lines 280, 337, 381
**Category:** Edge Case

#### Description

The contract does not validate that `dcaTotal > 0` for DCA orders. Division by zero is prevented by Solidity's automatic checks, but the behavior is undefined:

```solidity
// In canExecute (line 280)
uint256 requiredAmount = order.amountIn / order.dcaTotal;  // If dcaTotal=0, reverts with division error

// In executeOrder (line 337)
uint256 executeAmount = order.amountIn / order.dcaTotal;  // Reverts
```

**Issue:**
- No explicit error message
- Generic "division by zero" error instead of semantic error
- DCA orders with `dcaTotal=0` should be rejected during order signing stage

#### Impact

- User experience: confusing error message
- Offline validation should catch this, but on-chain validation is defensive

#### Recommendation

**Add explicit validation:**
```solidity
function canExecute(Order calldata order, bytes calldata signature) external view returns (...) {
    // ... existing checks ...

    if (order.orderType == OrderType.DCA) {
        if (order.dcaTotal == 0) return (false, "DCA total must be > 0");
        if (order.dcaInterval == 0) return (false, "DCA interval must be > 0");
    }

    // ... rest of function ...
}

function executeOrder(Order calldata order, bytes calldata signature, bytes calldata routerData) external nonReentrant {
    // ... existing checks ...

    if (order.orderType == OrderType.DCA) {
        if (order.dcaTotal == 0) revert InvalidDCATotal();
        if (order.dcaInterval == 0) revert InvalidDCAInterval();
    }
}
```

---

### L-05: Bootstrap Router Validation Not Enforced

**Severity:** Low
**Confidence:** Low
**Location:** Lines 566-576
**Category:** Best Practice

#### Description

The `bootstrap()` function whitelists routers without price/security validation:

```solidity
function bootstrap(address[] calldata routers) external {
    if (msg.sender != admin) revert NotAdmin();
    if (bootstrapped) revert AlreadyBootstrapped();
    bootstrapped = true;

    for (uint256 i = 0; i < routers.length; i++) {
        if (routers[i] == address(0)) revert ZeroAddress();  // Only checks for zero address
        whitelistedRouters[routers[i]] = true;
        emit Bootstrap(routers[i]);
    }
}
```

**Issue:**
- No validation that `routers[i]` is actually a contract
- No check for code size (could whitelist an EOA)
- No interface validation (could whitelist a token instead of a router)
- EOA addresses would cause `.call()` to succeed silently

#### Impact

- Admin could accidentally whitelist an EOA
- Malicious admin could whitelist a contract with code that doesn't implement swap logic
- Orders would "succeed" but produce no output

#### Recommendation

**Add contract validation (optional, depends on deployment assumptions):**
```solidity
function bootstrap(address[] calldata routers) external {
    if (msg.sender != admin) revert NotAdmin();
    if (bootstrapped) revert AlreadyBootstrapped();
    bootstrapped = true;

    for (uint256 i = 0; i < routers.length; i++) {
        if (routers[i] == address(0)) revert ZeroAddress();

        // Verify it's a contract
        uint256 size;
        assembly { size := extcodesize(routers[i]) }
        if (size == 0) revert NotAContract();

        whitelistedRouters[routers[i]] = true;
        emit Bootstrap(routers[i]);
    }
}
```

---

### I-01: EIP-712 Domain Name Hardcoded

**Severity:** Informational
**Confidence:** Medium
**Location:** Line 213
**Category:** Code Quality

#### Description

The EIP-712 domain name is hardcoded in the constructor:

```solidity
constructor(...) EIP712("TeraSwapOrderExecutor", "2") {
    // ...
}
```

**Observation:**
- The name "TeraSwapOrderExecutor" and version "2" are hardcoded
- Changes to contract name/version would require redeployment
- Not flexible for governance-driven upgrades (though this is not upgradeable)

#### Impact

- Informational only
- Not a security issue
- Consistent with design for immutable EIP-712 domain

#### Recommendation

This is acceptable as-is. If desired for clarity, add a comment:

```solidity
constructor(...) EIP712("TeraSwapOrderExecutor", "2") {
    // EIP-712 domain name: immutable for security
    // Version: corresponds to contract version
    // ...
}
```

---

### I-02: Missing Natspec for Internal Functions

**Severity:** Informational
**Confidence:** Low
**Location:** Lines 598-632 (_checkPriceCondition), 635-653 (getOrderHash)
**Category:** Documentation

#### Description

Internal and public utility functions lack comprehensive Natspec documentation:

```solidity
function _checkPriceCondition(
    address priceFeed,
    PriceCondition condition,
    uint256 targetPrice
) internal view returns (bool ok, string memory reason) {
    // No @dev, @param, @return comments
```

#### Impact

- Reduced code maintainability
- Harder for future auditors to understand edge cases
- Inconsistent with other well-documented functions

#### Recommendation

**Add Natspec comments:**
```solidity
/// @dev Validates that current price meets the order condition.
///      Handles both price feed validation (staleness, completeness) and price comparison.
/// @param priceFeed Chainlink price feed address (address(0) = no condition, always true)
/// @param condition ABOVE (>=) or BELOW (<=) target price
/// @param targetPrice Target price in 8 decimals (Chainlink format)
/// @return ok Whether condition is met
/// @return reason Human-readable failure reason (empty if ok=true)
function _checkPriceCondition(...)
```

---

## Systemic Observations

### 1. Precision Loss Pattern

The contract has **three sources of precision loss**:

1. **Fee calculation (M-01):** Integer division rounds down
2. **DCA splitting (M-02):** `amountIn / dcaTotal` truncates remainders
3. **Output validation (L-04):** `minAmountOut / dcaTotal` loses precision

All three are symptomatic of using fixed-size unsigned integers for fractional accounting. Consider:
- A unified precision handling approach (WAD/RAY)
- Explicit truncation comments explaining the choice
- Tests covering edge cases (prime number dcaTotal values, amounts not divisible by dcaTotal)

### 2. Chainlink Oracle Robustness

The contract implements strong oracle validation:
- ✅ Staleness check: `MAX_STALENESS = 3600` (1 hour)
- ✅ Incomplete round check: `answeredInRound >= roundId`
- ✅ Negative price check: `price > 0`
- ⚠️ **Missing:** Answer sanity checks (e.g., price deviation limits)
- ⚠️ **Missing:** Multiple price feed sources for critical pairs

**Recommendation:** Document the 1-hour staleness assumption. For critical trading pairs, consider:
```solidity
// Multiple feeds for critical pairs (e.g., ETH/USD)
mapping(bytes32 => address[]) public priceFeeds;  // primary, secondary, tertiary
```

### 3. Nonce Semantics Edge Case

Non-DCA orders use `nonces[owner]` for replay protection:
```solidity
if (order.orderType != OrderType.DCA && nonces[order.owner] != order.nonce) {
    return (false, "Nonce mismatch");
}
```

But `invalidateNonces()` can skip nonce values:
```solidity
// User: nonce=0, nonce=1 pending
// User calls: invalidateNonces(3)
// Now nonce=0 and nonce=1 are invalid, user must use nonce=3+
```

This is **intentional and correct** (mass cancel feature), but could confuse users. Recommend clear documentation:

```solidity
/// @notice Invalidate all orders with nonce < newNonce (mass cancellation).
/// @dev Example: If nonces[user]=2 (last executed) and user calls invalidateNonces(5),
///      then nonce values 0,1,2,3,4 become invalid. Next order must use nonce >= 5.
function invalidateNonces(uint256 newNonce) external {
```

### 4. Router Execution Trust Model

The contract implements "router whitelisting" but with an important assumption:

```solidity
(bool ok, bytes memory result) = order.router.call(routerData);
if (!ok) revert SwapFailed(result);
```

**Trust assumption:** Whitelisted routers will:
- Not steal approved tokens (they receive approval before call)
- Return output tokens to the contract
- Properly handle ETH

**Risk:** If a whitelisted router is compromised or acts maliciously:
1. Can steal all approved tokens (no amount limit on forceApprove)
2. Can steal additional user tokens if router has prior allowance
3. Cannot steal contract's existing balances (tokens pulled per-order)

**Recommendation:** Consider adding per-router approval caps:

```solidity
mapping(address => uint256) public routerApprovalCaps;  // max per order

function executeOrder(...) {
    uint256 cap = routerApprovalCaps[order.router];
    uint256 approval = cap > 0 ? min(netAmount, cap) : netAmount;
    IERC20(order.tokenIn).forceApprove(order.router, approval);
}
```

### 5. ETH Handling Complexity

The output handling (lines 384-411) is complex due to mixed ETH/ERC-20 scenarios:

```solidity
if (tokenOutBalance >= minOut) {
    // ERC-20 only path
    IERC20(order.tokenOut).safeTransfer(order.owner, tokenOutBalance);
} else if (order.tokenOut == WETH && ethReceived >= minOut) {
    // ETH-only path (router returned native ETH)
    (bool ethOk, ) = order.owner.call{value: ethReceived}("");
    if (!ethOk) {
        // Fallback: wrap to WETH
        IWETH(WETH).deposit{value: ethReceived}();
        IERC20(WETH).safeTransfer(order.owner, ethReceived);
    }
} else if (tokenOutBalance + ethReceived >= minOut) {
    // Mixed output (rare, but possible)
    // ...
}
```

**Edge cases handled well:**
- ✅ ETH transfer failure fallback to WETH wrapping
- ✅ Mixed output scenarios (ERC-20 + ETH)
- ✅ Minimum output validation across all paths

**Potential issue:** The "mixed output" path assumes `tokenOutBalance > 0 && ethReceived > 0`. If this happens unexpectedly, user receives both token and ETH, which could be surprise behavior.

### 6. DCA State Cleanup

DCA orders accumulate state but have no cleanup mechanism:

```solidity
mapping(bytes32 => uint256) public dcaExecutions;
mapping(bytes32 => uint256) public dcaLastExecution;
```

After a DCA order completes (100% of dcaTotal executed), the state remains in storage forever. For contracts with high volume, this could cause:
- Storage bloat
- Higher read costs for inactive orders
- Difficulty distinguishing "completed" from "active" orders

**Recommendation:** Implement optional cleanup:

```solidity
function completeDCAOrder(bytes32 orderHash) external {
    if (dcaExecutions[orderHash] < dcaOrders[orderHash].dcaTotal) {
        revert DCAChallengeRemaining();
    }
    delete dcaExecutions[orderHash];
    delete dcaLastExecution[orderHash];
}
```

---

## Appendix: Technical Details

### A. EIP-712 Domain Separator Verification

The contract correctly includes `chainId` in the domain separator via OpenZeppelin's EIP712:

```solidity
// Correct (uses _domainSeparatorV4() which includes chainId)
address signer = ECDSA.recover(_hashTypedDataV4(orderHash), signature);
```

This prevents **cross-chain signature replay**:
- Signature for Ethereum mainnet won't work on Polygon
- Signature for Mainnet won't work on testnet

✅ **Confirmed:** No cross-chain replay vulnerability

### B. Reentrancy Analysis

The contract uses `ReentrancyGuard` on `executeOrder()`:

```solidity
function executeOrder(...) external nonReentrant {
    // Line 362: IERC20(order.tokenIn).safeTransferFrom(...)
    // Line 372: (bool ok, bytes memory result) = order.router.call(routerData);
    // Line 390: IERC20(order.tokenOut).safeTransfer(...)
    // Line 394: (bool ethOk, ) = order.owner.call{value: ethReceived}("");
}
```

**Reentrancy points:**
1. `safeTransferFrom` → Can call `transferFrom` hooks if token is malicious ERC-777
2. `router.call()` → Can call arbitrary code
3. `safeTransfer` → Can call ERC-777 `tokensToSend` hooks
4. `order.owner.call{}` → Can call arbitrary code in owner (if contract)

**Mitigation analysis:**
- ✅ ReentrancyGuard prevents calling `executeOrder` recursively
- ✅ State updates (nonce increment, DCA tracking) happen AFTER external calls
- ⚠️ **But:** State is updated AFTER transfers, so a reentrant call to `executeOrder` with different order could double-spend

**Example attack (if ReentrancyGuard were absent):**
1. User has 1000 tokens, approves executor
2. Attacker creates malicious token that calls back into executeOrder during transfer
3. First execution: transfers 1000 tokens, updates nonce
4. During transfer, attacker's token calls executeOrder again with different order
5. nonce hasn't incremented yet (state updates are post-transfer), so replay check fails
6. Second execution transfers another 1000 tokens

**Verdict:** ✅ ReentrancyGuard prevents this (on the same function). But `canExecute()` is not protected. If `canExecute()` could be called during execution, it might return inconsistent state.

**Actual risk:** NONE, because `canExecute()` is view-only.

### C. Signature Validation Completeness

The contract uses `ECDSA.recover()`:

```solidity
address signer = ECDSA.recover(_hashTypedDataV4(orderHash), signature);
if (signer != order.owner) revert InvalidSignature();
```

**Potential issues:**
- ❌ **Signature malleability:** NOT an issue. OpenZeppelin's ECDSA rejects malleable signatures by default
- ❌ **Replay on different chain:** NOT an issue. EIP712 domain separator includes chainId
- ❌ **Replay on contract upgrade:** NOT an issue. Contract is immutable
- ❌ **Order modification in mempool:** NOT possible. Order is signed, modifications invalidate signature
- ✅ **Signature extraction:** CONFIRMED correct (65 bytes, v+r+s)

### D. Fee Collection Correctness

The fee is correctly collected:

```solidity
uint256 fee = (executeAmount * FEE_BPS) / BPS_DENOMINATOR;  // = 0.1%
uint256 netAmount = executeAmount - fee;

IERC20(order.tokenIn).safeTransferFrom(order.owner, address(this), executeAmount);
IERC20(order.tokenIn).safeTransfer(feeRecipient, fee);
IERC20(order.tokenIn).forceApprove(order.router, netAmount);
```

- ✅ Total transferred = fee + netAmount = executeAmount (conservation of tokens)
- ✅ Fee recipient receives exact fee amount
- ✅ Router receives exact netAmount
- ⚠️ Fee precision loss (see M-01)

### E. Test Coverage Assessment

Based on test file review:

| Category | Coverage | Status |
|---|---|---|
| Constructor validation | ✅ Complete | ZeroAddress checks |
| Basic execution flow | ✅ Complete | Happy path + fee calculation |
| Signature verification | ✅ Complete | Invalid sig, replay protection |
| H-01 Router whitelisting | ✅ Complete | Non-whitelisted router reverts |
| H-02 ETH output | ⚠️ Partial | Test incomplete |
| H-03 Nonce invalidation | ✅ Complete | Mass cancel + per-order |
| Price conditions | ✅ Complete | ABOVE/BELOW scenarios |
| Chainlink validation | ✅ Complete | Stale feed, incomplete round, negative price |
| DCA execution | ✅ Complete | Multi-execution, interval, completion |
| Timelock | ⚠️ Partial | Queue tests only, no full execute tests |
| Dust refund | ✅ Complete | Leftover input tokens |
| Error cases | ✅ Complete | Most paths covered |

**Gaps:**
- H-02 ETH output test incomplete
- M-03 Timelock race condition not tested
- Fuzz testing for DCA precision loss

### F. Gas Optimization Opportunities

1. **Cache repeated balance checks:** `balanceOf(order.owner)` called twice
2. **Inline small functions:** `getOrderHash()` could be inlined for single-use scenarios
3. **Batch price feeds:** Instead of querying one feed per order, batch queries
4. **DCA bitmap:** Track completed DCA orders in bitmap instead of mapping

**Estimated savings:** 5-15% gas per execution (low priority)

---

## Recommendations Summary

### Critical (Must Fix)
None identified. All critical paths are secure.

### High (Should Fix)
None confirmed. Potential precision loss vectors (M-01, M-02) are medium severity.

### Medium Priority (Recommended)
1. **M-01:** Implement rounding-up fee calculation or minimum order size
2. **M-02:** Implement cumulative DCA tracking to recover truncated amounts
3. **M-03:** Add temporal bounds to timelock execution (max execution window)

### Low Priority (Nice to Have)
1. **L-01:** Use custom errors consistently throughout
2. **L-02:** Enhance event emission for better monitoring
3. **L-03:** Minor gas optimization in price checking
4. **L-04:** Add explicit DCA total validation
5. **L-05:** Consider contract interface validation in bootstrap

### Informational (Documentation)
1. **I-01:** Document EIP-712 domain immutability
2. **I-02:** Add Natspec comments to internal functions
3. **I-XX:** Clarify nonce invalidation semantics
4. **I-XX:** Document Chainlink staleness assumptions
5. **I-XX:** Explain router approval trust model

---

## Conclusion

TeraSwapOrderExecutor v2 demonstrates strong security architecture with proper implementation of critical mitigations (H-01, H-02, H-03). The codebase is well-structured, uses industry-standard libraries correctly, and implements comprehensive validation.

**Primary concerns** center on **arithmetic precision** in fee and DCA calculations, which could leak small amounts of value over time and create spam vectors. These are Medium severity but straightforward to address.

**Secondary concerns** include minor best-practice improvements (consistent error handling, event design) and edge case validation.

The contract is **suitable for deployment** with recommended fixes for M-01 and M-02 before mainnet launch. The identified issues do not create unrecoverable loss-of-funds scenarios but warrant attention for protocol robustness.

**Deployment Checklist:**
- [ ] Implement M-01 fee precision fix
- [ ] Implement M-02 DCA truncation mitigation
- [ ] Consider M-03 timelock temporal bounds
- [ ] Add test coverage for ETH output handling
- [ ] Document nonce and oracle assumptions
- [ ] Conduct final mainnet configuration review
- [ ] Monitor first 100 executions for unexpected precision loss

---

**Report Generated:** March 5, 2026
**Audit Methodology:** 4-Phase (MAP → HUNT → ATTACK → REPORT)
**Confidence Level:** High for identified findings, Medium for unidentified risks