# CHORE-DCA-APPROVAL-FLOW — DCA must prompt the WETH→executor approval before signing

## Context (confirmed on-chain + in contract + UI)
The DCA flow signs the order (EIP-712 `Sign Typed Data`) but **never prompts an ERC-20 approval**. The
OrderExecutor pulls the input per chunk via `IERC20(tokenIn).safeTransferFrom(owner, address(this), amount)`
(`TeraSwapOrderExecutor.sol:483`) and `canExecute` checks
`IERC20(tokenIn).allowance(owner, address(this)) >= requiredAmount` → returns `(false, "Insufficient
allowance")` (`:368/:371`). With no approval, every DCA is **"placed" (signed) but never executes** — a silent
dead order. The keeper logs `Insufficient allowance` and skips (`0 executed, 1 skipped`).

So the *"your wallet only signs once"* copy is misleading: the contract uses a **direct allowance to the
executor** (NOT Permit2), which requires a one-time on-chain `approve` tx. Verified live: a WETH→USDC DCA was
signed, but the keeper skipped it on insufficient allowance.

## Objective
The DCA (and conditional-order) flow must guarantee a sufficient **WETH→executor** allowance before the order
can be signed/placed, so no order is ever created un-executable. Keep "No infinite approvals" (approve the
exact required amount, not max-uint).

## Requirements
1. **Allowance preflight + approve step.** Before enabling "Confirm & Sign Order", read
   `allowance(owner, executorForChain)` for the input token. If `< requiredTotal`, show an **"Approve WETH"**
   step (an `approve(executor, requiredTotal)` tx) and gate the sign button until it confirms. Flow becomes:
   *Approve WETH (once, exact amount) → Sign order*.
2. **requiredTotal = the order's total `amountIn`** (the contract pulls a cumulative total of `amountIn` across
   all chunks — `cumulativeTarget = amountIn * (execCount+1) / dcaTotal`, summing to `amountIn`). Approve at
   least `amountIn`; do not approve max-uint.
3. **Chain-aware:** executor address + input token resolved per chainId (mainnet vs Base); never hardcode.
4. **Copy fix:** replace "your wallet only signs once" with accurate copy (e.g. "Approve once, then sign —
   the executor runs it autonomously"). Don't claim signature-only when an approve tx is required.
5. **Display bug — per-buy vs total.** The review modal labels `amountIn` as **"Amount per buy"**, but per the
   contract `amountIn` is the **TOTAL** across all chunks (per-buy ≈ `amountIn / dcaTotal`). Verify against the
   contract and fix the labels/values so "Amount per buy" and any "Total to spend" are correct and consistent
   with what's signed + pulled. (A user reading "0.005 per buy" while only 0.005 total is pulled is a real
   expectation mismatch.)
6. **Apply to LimitOrderPanel / ConditionalOrderPanel too** (same allowance requirement) — folds in the
   spend-side parity flagged by `CHORE-DCA-UX-POLISH` (item 2).

## Verify
- Creating a DCA with allowance < total prompts "Approve WETH"; the sign button is disabled until approval.
- After approve + sign, the keeper executes chunk 1 on-chain (no "Insufficient allowance" skip).
- Subsequent chunks execute within the approved total; no per-chunk re-approval needed for a single DCA.
- "Amount per buy" / total figures match the contract semantics (per-buy = amountIn/dcaTotal).
- mainnet + Base; existing tests green; add tests for the allowance gate + the per-buy/total math.

## Do NOT
- Don't change the Solidity contract (the allowance model is correct) or the keeper.
- Don't approve max-uint (keep exact-amount, per "No infinite approvals").
- Don't regress instant swaps.

## Files affected (verify on `main`)
- DCA panel + the order review/confirm modal, LimitOrderPanel/ConditionalOrderPanel
- `src/hooks/useOrderEngine.ts` (allowance read + approve action + gating)
- per-chain executor + WETH config (`order-engine/config`, `src/lib/chains/*`)

## Expected output
- Branch `chore/dca-approval-flow` off latest `origin/main`; signed commits; CI green; FEEDBACK noting the
  per-buy/total resolution and any overlap with `CHORE-DCA-UX-POLISH` / `CHORE-DCA-WETH-INPUT`.
- Auditor: light recommended (touches the order/fund-flow approval UX, though no contract change).

## Quality criteria
No DCA/conditional order can be placed without a sufficient input allowance to the executor; approve is exact
amount, chain-aware; copy and per-buy/total figures are truthful; the keeper executes the first chunk after the
fixed flow with no manual steps.
