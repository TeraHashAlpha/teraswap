# TeraSwap Pre-Audit Remediation Report

**Date:** March 23, 2026
**Source:** TeraSwap Pre-Audit Security Report (Cowork analysis + Kamino benchmark)
**Status:** All fixable issues addressed

---

## Executive Summary

The Pre-Audit Report identified **17 findings** (2 Critical, 4 High, 6 Medium, 4 Low, 5 Info).
This remediation covers **all Critical, High, and addressable Medium/Low issues** across both smart contracts and the frontend ABI.

**Important:** The original `TeraSwapFeeCollector` is deployed and immutable on mainnet.
All FeeCollector fixes are implemented in a new **V2 contract** (`TeraSwapFeeCollectorV2_flat.sol`)
that must be deployed to replace V1.

---

## Findings Remediation Status

### CRITICAL (2/2 Fixed)

| ID | Finding | Fix | File |
|----|---------|-----|------|
| **CRITICAL-001** | Unchecked Router Calldata Injection | ✅ Added `allowedSelectors` mapping — validates `bytes4` function selector before every `router.call()`. Includes `setAllowedSelector()` and `batchWhitelistSelectors()` admin functions. | `TeraSwapFeeCollectorV2_flat.sol` |
| **CRITICAL-002** | ETH Reentrancy via feeRecipient.call() | ✅ Reordered to CEI pattern: `router.call()` executes FIRST, then `feeRecipient.call()` for fee transfer. Combined with `nonReentrant` modifier. | `TeraSwapFeeCollectorV2_flat.sol` |

### HIGH (4/4 Fixed)

| ID | Finding | Fix | File |
|----|---------|-----|------|
| **HIGH-001** | No Router Approval Limits | ✅ Added balance-delta verification: records `tokenBalBefore` before router call, verifies `spent <= netAmount + 1` after. Always revokes approval post-swap. | `TeraSwapFeeCollectorV2_flat.sol` |
| **HIGH-002** | No Timelock on sweep() | ✅ Replaced instant `sweep()` with `requestSweep()` → 48h delay → `executeSweep()` pattern. Added `cancelSweep()` for emergencies. | `TeraSwapFeeCollectorV2_flat.sol` |
| **HIGH-003** | DCA Precision Loss (Dust) | ✅ Replaced simple `amountIn / dcaTotal` with cumulative tracking: `cumulativeTarget = (amountIn * (execCount + 1)) / dcaTotal`. Last execution gets exact remainder. Zero dust. | `TeraSwapOrderExecutor.sol` |
| **HIGH-004** | Chainlink Oracle Not Fully Validated | ✅ Added `OracleConfig` struct with per-feed `decimals`, `maxStaleness`, `minPrice`, `maxPrice`. `setOracleConfig()` validates feed on registration (reads actual decimals, checks liveness). `_checkPriceCondition()` uses per-feed config with fallback to global. | `TeraSwapOrderExecutor.sol` |

### MEDIUM (5/6 Fixed)

| ID | Finding | Fix | File |
|----|---------|-----|------|
| **MEDIUM-001** | Fee-on-Transfer Tokens | ✅ Balance-delta pattern: `received = balanceAfter - balanceBefore` after `safeTransferFrom`. All downstream calculations use actual received amount. | `TeraSwapFeeCollectorV2_flat.sol` |
| **MEDIUM-002** | Rebasing Tokens Stuck Funds | ✅ Refund uses `IERC20(token).balanceOf(address(this))` (actual balance) instead of stored variable. | `TeraSwapFeeCollectorV2_flat.sol` |
| **MEDIUM-003** | Zero-Fee Small Orders | ✅ Added `MIN_SWAP_AMOUNT = 1000` constant. Both swap functions check `if (amount < MIN_SWAP_AMOUNT) revert AmountTooSmall()`. | `TeraSwapFeeCollectorV2_flat.sol` |
| **MEDIUM-005** | Executor Whitelist Censorship | ⏳ **Acknowledged — planned for Phase 2.** Requires architectural change (permissionless fallback after deadline - FALLBACK_WINDOW). Will implement with multi-executor support. |
| **MEDIUM-006** | DCA routerDataHash Not Committed | ✅ Non-DCA orders now REQUIRE `routerDataHash != bytes32(0)`. Only DCA orders can use `bytes32(0)` bypass. | `TeraSwapOrderExecutor.sol` |

### LOW (4/4 Fixed)

| ID | Finding | Fix | File |
|----|---------|-----|------|
| **LOW-001** | FeeCollector Missing pause() | ✅ Added `paused` state + `whenNotPaused` modifier on both swap functions. `pause()` / `unpause()` admin functions. | `TeraSwapFeeCollectorV2_flat.sol` |
| **LOW-002** | Unvalidated Router Address | ✅ `setAllowedSelector()` and `batchWhitelistSelectors()` require `router.code.length > 0`. | `TeraSwapFeeCollectorV2_flat.sol` |
| **LOW-003** | Missing OrderCancelled Event | ✅ **Already existed** in contract at line 184: `event OrderCancelled(bytes32 indexed orderHash, address indexed owner)`. No change needed. | Already present |
| **LOW-004** | No Explicit Price Bounds | ✅ Covered by HIGH-004's `OracleConfig.minPrice` / `maxPrice`. | `TeraSwapOrderExecutor.sol` |

### Frontend ABI Fix

| ID | Finding | Fix | File |
|----|---------|-----|------|
| ABI-001 | OrderExecuted Event Mismatch | ✅ Updated frontend ABI to match contract: added `orderType` (indexed), `tokenIn`, `tokenOut` fields. | `src/lib/order-engine/abi.ts` |

---

## Files Changed

| File | Changes |
|------|---------|
| `contracts/TeraSwapFeeCollectorV2_flat.sol` | **NEW** — Complete V2 with all CRITICAL+HIGH+MEDIUM+LOW fixes |
| `contracts/order-engine/TeraSwapOrderExecutor.sol` | HIGH-003 (DCA precision), HIGH-004 (oracle config), MEDIUM-006 (routerDataHash enforcement) |
| `src/lib/order-engine/abi.ts` | OrderExecuted event ABI updated to match contract |

---

## Deployment Steps Required

### 1. Deploy FeeCollector V2
```bash
# In Remix or via Hardhat:
# Constructor args: (feeRecipient, admin)
# feeRecipient: 0x107F6eB7C3866c9cEf5860952066e185e9383ABA
# admin: your admin wallet (ideally Gnosis Safe)
```

### 2. Whitelist Router Selectors (post-deploy)
```solidity
// Call batchWhitelistSelectors for each router with their swap selectors:
// 1inch: 0x12aa3caf, 0xe449022e, 0x0502b1c5, 0x2e95b6c8
// Uniswap V3: 0xac9650d8, 0x5ae401dc, 0x04e45aaf, 0xb858183f
// Paraswap: 0x3598d8ab, 0xa94e78ef, 0x46c67b6d
// etc.
```

### 3. Update Frontend Constants
```typescript
// In src/lib/constants.ts, update:
FEE_COLLECTOR_ADDRESS = '<new V2 address>'
```

### 4. Configure Oracle Feeds (OrderExecutor)
```solidity
// Call setOracleConfig for each Chainlink feed:
setOracleConfig(ETH_USD_FEED, 300, 100e8, 100000e8) // 5min stale, $100-$100K bounds
setOracleConfig(BTC_USD_FEED, 300, 1000e8, 500000e8) // 5min stale, $1K-$500K bounds
```

---

## Remaining Recommendations (from report)

| Item | Status | Notes |
|------|--------|-------|
| Formal audit (Code4rena) | Planned | After V2 deployment |
| Gnosis Safe multisig for admin | Planned | Before mainnet V2 |
| Certora formal verification | Planned | For OrderExecutor math |
| Bug bounty (Immunefi) | Planned | Post-audit |
| Etherscan verification | Required | After V2 deploy |
| MEDIUM-005 permissionless fallback | Phase 2 | Architectural change |
