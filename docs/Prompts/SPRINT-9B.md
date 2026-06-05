# Sprint 9B — FeeCollector minimumOutput Validation

**Sprint window:** 2026-04-23 → TBD
**Sprint goal:** Add on-chain output validation to `TeraSwapFeeCollector.sol` so the contract reverts if the router returns less than the user's specified minimum output. This closes finding H-04 from the external technical analysis — the highest-priority smart contract finding.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 9A COMPLETE. External analysis reviewed.
**Reference:** `Audits/TeraSwap-Technical-Analysis-2026-04-22.pdf` (finding H-04, page 11)

**IMPORTANT:** This sprint requires a new contract deployment and migration. The existing FeeCollector at `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD` is immutable — it cannot be upgraded in-place. The new contract must be deployed, routers bootstrapped, and the frontend updated to point to the new address.

---

## Sprint status table

| # | Prompt | Description | Status |
|---|--------|------------|--------|
| 66 | Add minimumOutput to FeeCollector contract | On-chain output validation + Foundry tests | ✅ DONE (`94cb469`) |
| 67 | Update frontend to pass minimumOutput | Wire slippage-adjusted minimumOutput through useSwap | ✅ DONE (`8097a86`) |
| 68 | Deploy new FeeCollector + migrate | Deploy script, bootstrap routers, update constants | Pending (awaiting mainnet deploy) |

---

## Prompt 66 — Add minimumOutput to FeeCollector contract

**Status:** Pending

**Context:** `TeraSwapFeeCollector.sol` pulls user tokens, deducts a 0.1% fee, approves the whitelisted router, and forwards arbitrary calldata. After the router executes, the contract refunds leftovers but does NOT verify that the user actually received the expected output tokens. If a whitelisted router is compromised (e.g., proxy upgrade), the contract silently forwards funds without protection.

Finding H-04 from the external analysis: *"If a whitelisted router is compromised or returns less than expected, the FeeCollector cannot prevent the loss."*

**Objective:** Add a `minimumOutput` parameter to both swap functions. After the router call, check the user's tokenOut balance increase and revert if it's below the minimum.

**Requirements:**

1. **Modify `swapTokenWithFee` signature:**
   ```solidity
   function swapTokenWithFee(
       address token,
       uint256 totalAmount,
       address router,
       bytes calldata routerData,
       address tokenOut,        // NEW: output token address (address(0) for ETH)
       uint256 minimumOutput    // NEW: minimum output the user expects
   ) external nonReentrant whenNotPaused {
   ```

2. **Add output validation after router call in `swapTokenWithFee`:**
   ```solidity
   // Snapshot balances BEFORE router call
   uint256 ethBefore = address(msg.sender).balance;
   uint256 tokenOutBefore = tokenOut != address(0)
       ? IERC20(tokenOut).balanceOf(msg.sender)
       : 0;
   
   // ... existing router call ...
   
   // Validate output AFTER router call + refunds
   if (minimumOutput > 0) {
       uint256 actualOutput;
       if (tokenOut == address(0)) {
           actualOutput = address(msg.sender).balance - ethBefore;
       } else {
           actualOutput = IERC20(tokenOut).balanceOf(msg.sender) - tokenOutBefore;
       }
       if (actualOutput < minimumOutput) revert InsufficientOutput(actualOutput, minimumOutput);
   }
   ```
   Note: `minimumOutput == 0` disables the check (backward compatibility for callers that don't set it).

3. **Modify `swapETHWithFee` signature similarly:**
   ```solidity
   function swapETHWithFee(
       address router,
       bytes calldata routerData,
       address tokenOut,        // NEW: output token (ERC-20 address for ETH→token swaps)
       uint256 minimumOutput    // NEW: minimum output
   ) external payable nonReentrant whenNotPaused {
   ```

4. **Add new error:**
   ```solidity
   error InsufficientOutput(uint256 actual, uint256 minimum);
   ```

5. **Add new event field:**
   ```solidity
   event SwapWithFee(
       address indexed user,
       address indexed router,
       address tokenIn,
       uint256 totalAmount,
       uint256 feeAmount,
       address tokenOut,        // NEW
       uint256 outputAmount     // NEW
   );
   ```

6. **Add Foundry tests in `test/TeraSwapFeeCollector.t.sol`:**
   - Test: swap succeeds when output >= minimumOutput
   - Test: swap reverts with `InsufficientOutput` when output < minimumOutput
   - Test: swap succeeds when minimumOutput == 0 (backward compat, no check)
   - Test: ETH→Token swap with minimumOutput validation
   - Test: Token→ETH swap with minimumOutput validation
   - Test: Token→Token swap with minimumOutput validation

**Files affected:**
- `contracts/TeraSwapFeeCollector.sol` (modify both swap functions + add error/event)
- `contracts/test/TeraSwapFeeCollector.t.sol` (add minimumOutput tests)

**Do NOT:**
- Do NOT change the fee calculation logic (FEE_BPS, BPS_DENOMINATOR).
- Do NOT change the timelock mechanism.
- Do NOT change the router whitelist logic.
- Do NOT change the admin/pause/sweep functions.
- Do NOT remove the existing refund logic — minimumOutput check runs AFTER refunds.

**Quality criteria:**
- `forge build` passes.
- `forge test` — all existing + new tests pass.
- Both swap functions accept tokenOut + minimumOutput parameters.
- Reverts with `InsufficientOutput(actual, minimum)` when output too low.
- minimumOutput == 0 disables the check (backward compatible).
- Event emits actual output amount.
- Commit message: `feat(contract): add minimumOutput validation to FeeCollector [H-04]`

---

## Prompt 67 — Update frontend to pass minimumOutput

**Status:** Pending

**Context:** With the new FeeCollector contract requiring `tokenOut` and `minimumOutput` parameters, the frontend's `useSwap.ts` must pass these values when building the FeeCollector transaction.

**Objective:** Wire the slippage-adjusted minimum output through the swap execution flow to the FeeCollector call.

**Requirements:**

1. **In `src/hooks/useSwap.ts`** — where the FeeCollector calldata is built (the `swapTokenWithFee` / `swapETHWithFee` encoding):
   - Add `tokenOut` address (the destination token's contract address, or `address(0)` for ETH)
   - Calculate `minimumOutput` from the quoted output amount minus the user's slippage tolerance:
     ```typescript
     const minimumOutput = BigInt(toAmount) * BigInt(10000 - slippageBps) / BigInt(10000)
     ```
   - Pass both as additional parameters in the ABI encoding.

2. **Update the FeeCollector ABI** in `src/lib/constants.ts` or wherever it's defined — add the new parameters to both function signatures.

3. **Update `TransactionPreview.tsx`** — decode and display `minimumOutput` in the transaction preview so users can see the minimum they'll receive before signing.

**Files affected:**
- `src/hooks/useSwap.ts` (pass minimumOutput in FeeCollector calldata)
- `src/lib/constants.ts` (update FeeCollector ABI)
- `src/components/TransactionPreview.tsx` (display minimumOutput)

**Do NOT:**
- Do NOT change the slippage calculation logic — use the existing slippage value.
- Do NOT change the quote flow or adapter logic.
- Do NOT change the FeeCollector address yet (that's Prompt 68).

**Quality criteria:**
- `npm run build` passes.
- `npm run lint` clean.
- FeeCollector calls include tokenOut + minimumOutput.
- TransactionPreview shows minimum output amount.
- Commit message: `feat(swap): pass minimumOutput to FeeCollector for on-chain protection [H-04]`

---

## Prompt 68 — Deploy new FeeCollector and migrate

**Status:** Pending

**Context:** The new FeeCollector with minimumOutput validation must be deployed to mainnet, routers bootstrapped, and the frontend pointed to the new address.

**Objective:** Deploy the updated contract, bootstrap routers, update frontend constants.

**Prerequisites (manual steps BEFORE this prompt):**

1. Deploy new FeeCollector via Foundry:
   ```bash
   forge create --rpc-url $RPC_URL --private-key $DEPLOYER_KEY \
     contracts/TeraSwapFeeCollector.sol:TeraSwapFeeCollector \
     --constructor-args $FEE_RECIPIENT $ADMIN_ADDRESS
   ```
2. Bootstrap routers on new contract (same set as current contract).
3. Verify on Etherscan.
4. Note the new contract address.

**Requirements (for code agent):**

1. **Update `src/lib/constants.ts`:**
   - Change `FEE_COLLECTOR_ADDRESS` to the new deployed address.
   - Add `FEE_COLLECTOR_V1_ADDRESS` constant pointing to the old address (for reference/analytics continuity).
   - Update `FEE_COLLECTOR_ABI` if not already done in P67.

2. **Update deploy documentation** — add new contract address to the deploy guide.

3. **Keep old contract address in analytics** — the `/api/analytics` endpoint should recognize swaps through both old and new FeeCollector addresses.

**Files affected:**
- `src/lib/constants.ts` (new FeeCollector address)
- Deploy docs

**Do NOT:**
- Do NOT remove the old contract from the codebase — keep as V1 reference.
- Do NOT run the deploy — that's a manual step by the founder.

**Quality criteria:**
- `npm run build` passes.
- `npm run test` passes.
- New FeeCollector address in constants.
- Old address preserved as V1 reference.
- Commit message: `chore(deploy): migrate to FeeCollector v2 with minimumOutput [H-04]`

---

## Auditor review — Sprint 9B

**Scope:** Review contract changes, frontend wiring, and deployment.

**Checklist:**

1. **Contract (P66):**
   - [ ] Both swap functions accept tokenOut + minimumOutput
   - [ ] Balance snapshot before router call, validation after
   - [ ] Reverts with InsufficientOutput when output < minimum
   - [ ] minimumOutput == 0 disables check (backward compat)
   - [ ] Event emits actual output
   - [ ] No changes to fee/timelock/whitelist logic
   - [ ] All Foundry tests pass

2. **Frontend (P67):**
   - [ ] minimumOutput = quotedOutput * (1 - slippage)
   - [ ] ABI updated with new parameters
   - [ ] TransactionPreview shows minimum output
   - [ ] Build clean

3. **Deploy (P68):**
   - [ ] New address in constants
   - [ ] Old address preserved as V1
   - [ ] Router bootstrap matches current set
   - [ ] Contract verified on Etherscan

4. **Regression:**
   - [ ] All 423+ tests pass
   - [ ] Swap flow works end-to-end
   - [ ] Non-FeeCollector swaps (0x, CoW) unaffected
   - [ ] Analytics tracks both old and new contract

**Expected output:** Findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## See also

- External analysis H-04: `Audits/TeraSwap-Technical-Analysis-2026-04-22.pdf` (page 11)
- Current contract: `contracts/TeraSwapFeeCollector.sol`
- Current tests: `contracts/test/TeraSwapFeeCollector.t.sol`
- Deployed at: `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD` (V1, no minimumOutput)
- Sprint 9A: `docs/Prompts/SPRINT-9A.md` — COMPLETE (H-01, H-02, H-03 closed)
