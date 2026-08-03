# BUG-SWAP-APPROVE-STALE-SUCCESS — stale "swap done" state after approve in a repeat-swap flow

> **Source:** owner repro on production (2026-07-17): (1) swap token X with a LOW amount — approve → swap →
> success (button green "done"). (2) Immediately swap the SAME token with a LARGER amount — allowance is now
> insufficient so the app correctly asks for a new approve; the user approves; **the swap button then flips
> straight to the green "executed" state WITHOUT the swap ever being sent.** No swap tx exists on-chain. The
> only recovery is leaving the swap tab and re-entering (remount resets the state). Hypothesis (verify, don't
> assume): the PREVIOUS swap's success state (wagmi `useWriteContract`/`useWaitForTransactionReceipt` result,
> or the equivalent slice in the swap store) is never reset when a new approve cycle starts, so when the
> approve receipt lands the UI renders the stale success — conflating the approve tx with a swap tx.
> UI/flow state only — the fix must NOT change tx construction, routing, quotes, or any guard. → **no Auditor
> gate; Auditor note in the PR body** (swap-flow adjacent but strictly state-machine). SSH-signed; branch
> `fix/swap-approve-stale-success` off `origin/main`, dedicated worktree; 3 droppable commits.
> **Exit = push + compare link (CI runs when the owner opens the PR); the owner opens the PR.**

## Requirements (per-commit)

### 1. Reproduce as a failing test FIRST
State-machine/component test reproducing the exact sequence: quote → approve(small) → swap success → new
amount (larger, allowance insufficient) → approve flow → **assert the button/UI is in "ready to swap" state,
NOT success**, and that no swap send was triggered. Likely homes: `src/components/SwapButton.tsx` +
`src/hooks/useSwap.ts` / `useApproval.ts` (+ swap store). The test must FAIL against current main (prove the
repro), then pass with the fix.

### 2. Root-cause + fix
- Find where the success state survives: stale wagmi hook result kept across cycles, a store flag not
  cleared, or an effect that treats "tx receipt success" generically (approve receipt satisfying the swap
  success condition). State the mechanism explicitly in FEEDBACK.
- Fix so the state machine is strict: approve success transitions to `ready` (button = "Swap"), NEVER to
  `success`; any input change (amount, token pair, chain) or entry into an approve cycle RESETS the previous
  swap's success/error state (wagmi `reset()` and/or store reset). Success state is keyed to the SWAP tx
  hash — a state that cannot exist without a corresponding swap tx hash for the CURRENT quote/inputs.
- No changes to: calldata construction, router/spender resolution, allowance math, quote logic, guards
  (SC-04/R1 paths), order-engine hooks.

### 3. Class sweep + tests
- Sweep the SAME stale-success class in the repo's other tx-button flows (order create/cancel modals,
  ActiveApprovals revoke) — REPORT findings in FEEDBACK; fix ONLY the swap flow in this PR (others become
  follow-ups; do not widen the diff).
- Regression tests: the §1 repro (now green); approve-only cycle never yields success state; success resets
  on amount/token/chain change; back-to-back swaps (same token, growing amounts) each require their own swap
  tx before showing success. Full suite + tsc + eslint green.

## Do NOT
Change tx construction/routing/quote/guard logic; touch order-engine, chains config, or v3 files; refactor
beyond the state machine; add deps; open a PR.

## Files affected (read ONLY these + tests)
`src/components/SwapButton.tsx`, `src/components/SwapBox.tsx`, `src/hooks/useSwap.ts`,
`src/hooks/useApproval.ts`, the swap Zustand store slice, their test files,
`docs/Prompts/BUG-SWAP-APPROVE-STALE-SUCCESS.md` (commit this spec). Read-only for the class sweep: other
tx-flow components/hooks (list findings only).

## Expected output
Branch pushed + compare link (CI runs at PR time). FEEDBACK ≤1 screen: the root-cause mechanism (exact
line/hook), the state-machine change, the repro test names, class-sweep findings. Auditor note for the PR
body: state-machine-only diff, no tx-path changes.

## Quality criteria
Failing-test-first repro; approve can never produce a success state; success keyed to a swap tx hash;
sweep reported without widening the diff; suite green.
