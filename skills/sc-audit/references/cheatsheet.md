# Vulnerability Cheatsheet

Quick-reference lookup for 40+ vulnerability patterns. For each: what to look for,
how to detect it, when it's a false positive, and how to fix it.

## Table of Contents
1. [Reentrancy](#1-reentrancy)
2. [Access Control](#2-access-control)
3. [Oracle & Price Manipulation](#3-oracle--price-manipulation)
4. [Flash Loan Vectors](#4-flash-loan-vectors)
5. [Arithmetic & Precision](#5-arithmetic--precision)
6. [Proxy & Upgrades](#6-proxy--upgrades)
7. [Input Validation](#7-input-validation)
8. [External Call Safety](#8-external-call-safety)
9. [Signatures & Replay](#9-signatures--replay)
10. [DoS & Griefing](#10-dos--griefing)
11. [MEV & Frontrunning](#11-mev--frontrunning)
12. [Cryptographic Issues](#12-cryptographic-issues)
13. [Data Management](#13-data-management)
14. [Code Quality](#14-code-quality)

---

## 1. Reentrancy

### 1a. Classic (Same-Function) Reentrancy
- **Pattern**: External call before state update in same function
- **Detect**: `call{value:}` or `transfer()` or `safeTransfer()` before balance/state update
- **False positive**: `nonReentrant` modifier present, or only reads after call
- **Fix**: Checks-Effects-Interactions pattern, or ReentrancyGuard

### 1b. Cross-Function Reentrancy
- **Pattern**: Function A makes external call, attacker re-enters through Function B which reads stale state
- **Detect**: Two functions share state variable, one calls external before updating, other reads it
- **False positive**: Both protected by same ReentrancyGuard
- **Fix**: Global ReentrancyGuard across all state-sharing functions

### 1c. Cross-Contract Reentrancy
- **Pattern**: Contract A calls Contract B, which calls back into Contract A or Contract C using stale state from A
- **Detect**: Multi-contract system where external calls cross trust boundaries before state finalization
- **False positive**: Trusted internal contracts with no external entry points
- **Fix**: Complete state updates before any cross-contract calls

### 1d. Read-Only Reentrancy
- **Pattern**: View function returns stale data during a reentrant call, used by another protocol
- **Detect**: View functions in contracts with external calls that modify the state those views read
- **False positive**: No external protocols depend on the view function
- **Fix**: ReentrancyGuard on view functions, or document the limitation

---

## 2. Access Control

### 2a. Missing Access Control
- **Pattern**: State-changing function lacks `onlyOwner`/`onlyRole`/auth modifier
- **Detect**: `public`/`external` functions that modify critical state without access checks
- **False positive**: Function is intentionally permissionless (e.g., liquidation)
- **Fix**: Add appropriate modifier or require statement

### 2b. tx.origin Authentication
- **Pattern**: Using `tx.origin` instead of `msg.sender` for authorization
- **Detect**: Grep for `tx.origin`
- **False positive**: Using for gas-relay pattern detection (not auth)
- **Fix**: Replace with `msg.sender`

### 2c. Unprotected Initializer
- **Pattern**: `initialize()` function callable multiple times or by anyone
- **Detect**: Missing `initializer` modifier from OpenZeppelin, no `initialized` flag
- **False positive**: Using proper Initializable pattern
- **Fix**: Use OpenZeppelin `Initializable` or `initializer` modifier

### 2d. Centralization Risk
- **Pattern**: Single admin can drain funds, pause forever, change critical params without timelock
- **Detect**: Owner-only functions with high impact and no timelock/multisig requirement
- **False positive**: Intended design with documented trust assumptions
- **Fix**: Timelock, multisig, governance, or at minimum document the risk

---

## 3. Oracle & Price Manipulation

### 3a. Spot Price Manipulation
- **Pattern**: Using `getReserves()` or current pool price as oracle
- **Detect**: Reading AMM reserves directly for price calculation
- **False positive**: Using TWAP or Chainlink instead of spot
- **Fix**: Use Chainlink, TWAP (Uniswap v3), or manipulation-resistant oracle

### 3b. Stale Oracle Data
- **Pattern**: Not checking oracle freshness (roundId, updatedAt, answeredInRound)
- **Detect**: Chainlink `latestRoundData()` without validating `updatedAt` or `answeredInRound`
- **False positive**: Freshness check exists
- **Fix**: Check `updatedAt > block.timestamp - HEARTBEAT`, check `answeredInRound >= roundId`

### 3c. Oracle Decimal Mismatch
- **Pattern**: Assuming oracle returns 18 decimals when it returns 8
- **Detect**: Missing `decimals()` call on price feed
- **False positive**: Decimals explicitly handled
- **Fix**: Always call `decimals()` and normalize

---

## 4. Flash Loan Vectors

### 4a. Atomic Price Manipulation
- **Pattern**: Flash borrow → manipulate pool → exploit protocol → repay
- **Detect**: Any function that reads on-chain price and makes financial decision in same tx
- **False positive**: Uses TWAP oracle with sufficient window
- **Fix**: TWAP oracle, borrowing fee, or multi-block delay

### 4b. Flash Loan Governance Attack
- **Pattern**: Flash borrow tokens → vote/propose → execute → return tokens
- **Detect**: Governance using current token balance for voting power
- **False positive**: Snapshot-based voting (ERC20Votes with checkpoints)
- **Fix**: Use checkpointed voting power, not current balance

---

## 5. Arithmetic & Precision

### 5a. Overflow/Underflow
- **Pattern**: Arithmetic overflow in Solidity <0.8 or inside `unchecked {}` blocks
- **Detect**: Solidity version <0.8 without SafeMath, or `unchecked` arithmetic on user input
- **False positive**: Solidity >=0.8 without unchecked, or SafeMath used, or values bounded
- **Fix**: Use Solidity >=0.8, or SafeMath, or validate inputs before unchecked blocks

### 5b. Division Before Multiplication
- **Pattern**: `(a / b) * c` losing precision vs `(a * c) / b`
- **Detect**: Division followed by multiplication on integer values
- **False positive**: Intentional rounding, or values large enough that loss is negligible
- **Fix**: Multiply before divide

### 5c. Rounding in Favor of User
- **Pattern**: Division rounding down when it should round up (or vice versa) favoring the user over the protocol
- **Detect**: Integer division in fee calculation, share computation, exchange rate
- **False positive**: Rounding explicitly designed to favor protocol
- **Fix**: Use `mulDivUp` or add 1 when rounding should favor protocol

### 5d. Phantom Overflow
- **Pattern**: Intermediate calculation overflows even if final result fits
- **Detect**: Large multiplications that exceed uint256 before division
- **False positive**: Using mulDiv assembly that handles this
- **Fix**: Use `FullMath.mulDiv` or reorder operations

---

## 6. Proxy & Upgrades

### 6a. Storage Collision
- **Pattern**: New implementation changes storage layout, corrupting existing data
- **Detect**: Reordered, removed, or inserted storage variables between versions
- **False positive**: Using ERC-7201 namespaced storage
- **Fix**: Only append new variables, use storage gaps, or use namespaced storage

### 6b. Uninitialized Implementation
- **Pattern**: Implementation contract not calling `_disableInitializers()` in constructor
- **Detect**: Implementation deployable without initialization protection
- **False positive**: Constructor calls `_disableInitializers()`
- **Fix**: Add `constructor() { _disableInitializers(); }` to implementation

### 6c. Function Selector Clash
- **Pattern**: Proxy and implementation share a function selector (Transparent proxy)
- **Detect**: Matching 4-byte selectors between proxy admin functions and implementation
- **False positive**: Using TransparentUpgradeableProxy which routes by msg.sender
- **Fix**: Use TransparentUpgradeableProxy or UUPS pattern

### 6d. UUPS Missing upgrade auth
- **Pattern**: `_authorizeUpgrade` not overridden or not protected
- **Detect**: UUPS proxy without proper access control on upgrade function
- **False positive**: Proper `onlyOwner` on `_authorizeUpgrade`
- **Fix**: Override `_authorizeUpgrade` with access control

---

## 7. Input Validation

### 7a. Missing Zero-Address Check
- **Pattern**: Setting critical address (owner, token, pool) without checking for address(0)
- **Detect**: Address parameters used in constructor/initializer/setter without `require(addr != address(0))`
- **False positive**: address(0) is handled downstream, or non-critical parameter
- **Fix**: Add zero-address validation

### 7b. Missing Bounds Check
- **Pattern**: Parameters like fee percentage, slippage, deadline accepted without range validation
- **Detect**: Numeric parameters that control financial logic without min/max checks
- **False positive**: Bounded by type (e.g., uint8 for percentage) or checked elsewhere
- **Fix**: Add require statements with sensible bounds

### 7c. Array Length Mismatch
- **Pattern**: Two related arrays (addresses + amounts) without length equality check
- **Detect**: Multi-array parameters processed in same loop
- **False positive**: Length check exists
- **Fix**: `require(addresses.length == amounts.length)`

---

## 8. External Call Safety

### 8a. Unchecked Return Value
- **Pattern**: Low-level `.call()` return value not checked
- **Detect**: `address.call(...)` without checking the bool return
- **False positive**: Return value captured and checked
- **Fix**: `(bool success, ) = addr.call(...); require(success)`

### 8b. Weird ERC20 Tokens
- **Pattern**: Assuming all ERC20 tokens behave like standard (some return no value, some take fees, some rebase)
- **Detect**: Direct `.transfer()/.transferFrom()` without SafeERC20, or assuming amount received == amount sent
- **False positive**: Using SafeERC20, and checking balance difference for fee-on-transfer tokens
- **Fix**: Use SafeERC20, measure actual balance change, handle rebasing

### 8c. Unsafe External Contract Interaction
- **Pattern**: Calling untrusted external contract without gas limit or error handling
- **Detect**: Arbitrary address `.call()` without try/catch or gas stipend
- **False positive**: Trusted, immutable contract addresses
- **Fix**: Use try/catch, set gas limit, or validate contract address

---

## 9. Signatures & Replay

### 9a. Missing Nonce
- **Pattern**: Signature can be reused because there's no nonce
- **Detect**: ecrecover/ECDSA.recover without nonce parameter in signed message
- **False positive**: Nonce or deadline makes replay impossible
- **Fix**: Include incrementing nonce in signed data

### 9b. Cross-Chain Replay
- **Pattern**: Signature valid on multiple chains because chainId not in signed data
- **Detect**: EIP-712 domain separator missing chainId, or using hardcoded chainId
- **False positive**: Domain separator includes block.chainid
- **Fix**: Include `block.chainid` in domain separator, recompute on chain fork

### 9c. Signature Malleability
- **Pattern**: Using raw ecrecover which accepts both (v,r,s) and (v,r,-s) for same signer
- **Detect**: Direct `ecrecover` without OpenZeppelin's ECDSA library
- **False positive**: Using ECDSA.recover which validates s-value
- **Fix**: Use OpenZeppelin ECDSA.recover

### 9d. Missing Deadline
- **Pattern**: Signed message has no expiry, valid forever
- **Detect**: Permit or meta-transaction without deadline/expiry field
- **False positive**: Deadline included and checked
- **Fix**: Add deadline parameter, check `block.timestamp <= deadline`

---

## 10. DoS & Griefing

### 10a. Unbounded Loop
- **Pattern**: Loop iterates over array that grows without limit
- **Detect**: `for` loop over dynamic array that users can append to
- **False positive**: Array size is bounded by design or admin-controlled
- **Fix**: Pagination, bounded array size, or pull-over-push pattern

### 10b. Block Gas Limit DoS
- **Pattern**: Transaction requires more gas than block limit due to operations on large data
- **Detect**: Batch operations without size limits
- **False positive**: Batch size bounded to safe limit
- **Fix**: Add max batch size, use pagination

### 10c. Unexpected Revert (Push vs Pull)
- **Pattern**: Sending ETH/tokens to address that can revert (e.g., contract without receive())
- **Detect**: Push pattern: iterating and sending to multiple addresses where one failure reverts all
- **False positive**: Using pull pattern (users claim their funds)
- **Fix**: Use pull pattern, or wrap individual transfers in try/catch

### 10d. Storage Bloat
- **Pattern**: Unbounded mapping or array that attacker can fill cheaply
- **Detect**: Public functions that add to storage without cost or limit
- **False positive**: Economic cost prevents spam (e.g., requires token stake)
- **Fix**: Require minimum deposit, limit entries per user, or use expiry

---

## 11. MEV & Frontrunning

### 11a. Sandwich Attack
- **Pattern**: DEX swap with predictable slippage that can be sandwiched
- **Detect**: Swap function with user-specified `amountOutMin` that could be set too low
- **False positive**: Uses private mempool (Flashbots) or commit-reveal
- **Fix**: Tight slippage tolerance, use private transaction relayers

### 11b. Transaction Ordering Dependence
- **Pattern**: Outcome depends on transaction ordering (first-come-first-served)
- **Detect**: Functions where front-runner can extract value by seeing pending tx
- **False positive**: Commit-reveal scheme, or outcome is order-independent
- **Fix**: Commit-reveal, batch auctions, or MEV protection

### 11c. Approval Front-Running
- **Pattern**: `approve()` can be front-run when changing from non-zero to non-zero
- **Detect**: Direct `approve()` without first setting to 0
- **False positive**: Using `increaseAllowance`/`decreaseAllowance`
- **Fix**: Use increaseAllowance/decreaseAllowance, or set to 0 first

---

## 12. Cryptographic Issues

### 12a. Hash Collision with encodePacked
- **Pattern**: `abi.encodePacked` with multiple dynamic types creates collision risk
- **Detect**: `abi.encodePacked(string, string)` or `abi.encodePacked(bytes, bytes)`
- **False positive**: Only one dynamic type, or fixed-length types
- **Fix**: Use `abi.encode` instead

### 12b. Insufficient Randomness
- **Pattern**: Using block.timestamp, block.difficulty, blockhash for randomness
- **Detect**: On-chain "random" number generation
- **False positive**: Using Chainlink VRF or commit-reveal
- **Fix**: Chainlink VRF, commit-reveal scheme, or accept the risk with documentation

---

## 13. Data Management

### 13a. Stale Data After External Call
- **Pattern**: Cached value becomes stale because external call modified underlying state
- **Detect**: Reading value, making external call, then using the stale cached value
- **False positive**: Value cannot change during the external call
- **Fix**: Re-read after external call, or update cache

### 13b. Incomplete State Cleanup
- **Pattern**: `delete` on struct or mapping leaves nested data
- **Detect**: `delete myStruct` where struct contains mappings
- **False positive**: Mapping data is not security-relevant
- **Fix**: Manually clear nested mappings before delete

### 13c. Uninitialized Storage Pointer
- **Pattern**: Local storage variable declared but not assigned, points to slot 0
- **Detect**: `Type storage x;` without assignment (older Solidity)
- **False positive**: Solidity >=0.5.0 catches this at compile time
- **Fix**: Always initialize storage pointers

---

## 14. Code Quality

### 14a. Missing Events
- **Pattern**: State-changing functions don't emit events
- **Detect**: Functions modifying storage without `emit` statement
- **Impact**: Low — affects off-chain monitoring, not security
- **Fix**: Emit events for all state changes

### 14b. Floating Pragma
- **Pattern**: `pragma solidity ^0.8.0` instead of fixed version
- **Detect**: Caret (^) or range in pragma
- **Impact**: Informational — could compile with untested version
- **Fix**: Use fixed pragma: `pragma solidity 0.8.20;`

### 14c. Unused Return Values
- **Pattern**: Function return value ignored
- **Detect**: Function call without capturing return
- **Impact**: Low to Medium depending on what's ignored
- **Fix**: Capture and validate return values

### 14d. Shadowed Variables
- **Pattern**: Local variable shadows state variable or parent contract variable
- **Detect**: Same name used in different scopes
- **Impact**: Low — confusion leading to bugs
- **Fix**: Rename to avoid shadowing
