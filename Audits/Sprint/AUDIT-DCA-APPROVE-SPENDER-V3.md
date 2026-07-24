# AUDIT-DCA-APPROVE-SPENDER-V3 — fund-flow-adjacent gate (wallet approval spender)

## VERDICT: ⛔ CANNOT APPROVE — the fix is NOT PRESENT on `fix/dca-approve-spender-v3`. Nothing to audit; the bug is unfixed. (0C/0H not evaluable → merge NOT authorized.)

This is not a findings-BLOCK — it is a **grounding failure**: the change described in the audit brief does not
exist on the branch. Per AUDITOR-ROLE I will not fabricate a pass for code I cannot read, and I cannot issue
0C/0H against an absent diff.

### Evidence (device git, read-only)
- **Branch exists but carries no fix.** `fix/dca-approve-spender-v3` tip = `18695c5` — byte-identical to
  `origin/main` HEAD (the merged #311 `fix/swap-approve-stale-success`). `git log <merge-base>..branch` contains
  only unrelated merged work (#306–#311: ChainSelector, swap stale-success, Arbitrum UI, wagmi) — **zero**
  DCA-approve-spender commits, no failing-test-first commit.
- **`resolveSigningExecutor` does not exist** anywhere reachable: absent from `src/lib/order-engine/config.ts`
  and `src/hooks/useOrderApproval.ts` on the branch (grep = 0), absent on `origin/main`, absent on the device
  working tree.
- **The bug is present and unfixed on the branch.** `src/hooks/useOrderApproval.ts:66` still reads
  `const spender = getOrderExecutor(chainId)` — the unconditional **v2** resolution. The file imports only
  `getOrderExecutor` (line 34), takes **no** `isV3Order` parameter, and has no v3-aware branch. This is exactly
  the reported defect: a v3-signed DCA order (keeper routes to v3) gets its ERC-20 allowance sent to the **v2**
  executor → `allowance(owner→v3)=0` → keeper skips "Insufficient allowance" forever.
- **No uncommitted work-in-progress.** `git worktree list` shows no live worktree checked out on the branch;
  the device `main` worktree's only dirty files are build cache / the Arbitrum manifest / prior audit reports —
  none touch the approval or signing path.
- **Not pushed to origin.** `git ls-remote origin refs/heads/fix/dca-approve-spender-v3` is empty; the PR is
  still `#NNN` (unassigned) — consistent with the fix never having been implemented.
- The bug spec `docs/Prompts/BUG-DCA-APPROVE-SPENDER-V3.md` IS committed and correctly describes the intended
  fix (single-source `resolveSigningExecutor`, `useOrderApproval(isV3Order)`, OrderReviewModal wiring,
  invariant tests) — but the implementation to match it is not there.

### Explicit answer to the brief's core question ("can any call site still diverge?")
**Yes — every v3 call site diverges, because the fix does not exist.** `useOrderApproval` resolves the spender
through `getOrderExecutor(chainId)` (v2 only) while the signing path (`useOrderEngine.confirmOrder`, PR #299)
resolves the executor v3-aware via `getOrderExecutorV3`. The two lookups are unlinked today; the proposed
single-source `resolveSigningExecutor` that would bind them has not been added. Approve-spender ≠
signing-executor for every v3 order — the divergence the audit was meant to confirm closed is fully open.

### What a future re-audit needs (this branch is not ready for the gate)
Implement the spec, then re-request. The auditor pass will verify, against a branch that actually contains the diff:
1. **Single source of truth** — `resolveSigningExecutor(chainId, isV3Order)` in `config.ts`; **no** remaining
   direct `getOrderExecutor`/`getOrderExecutorV3` in any approval OR signing path (the class, not the instance).
2. **Predicate parity** — approve-time `isV3Order` uses the EXACT predicate sign-time uses
   (`o.maxSlippageBps !== undefined`), including edges (`maxSlippageBps===0` vs `undefined`, missing field in old
   drafts, Limit/SL-TP shapes).
3. **Spender allowlist (Sprint-40)** — v3 executor accepted via registry/env, no hardcoded hex, arbitrary
   spenders still rejected; env unset ⇒ byte-identical v2 behaviour.
4. **Approval UX** — EXACT-amount approve preserved (no infinite approve); the owner's wrong-spender state
   (allowance on v2, order v3) re-prompts a normal exact approve to v3.
5. **Failing-test-first** — the first commit's test genuinely fails on pre-fix `main`; invariant test
   (`approveSpender === signingExecutor` for v2 and v3, mainnet null) catches future divergence.
6. **Adjacency** — the diff touches NO keeper / contract / tx-construction / SC-04 / R1 code.

_Read-only; no source edited. No verdict block appended to AUDIT-TOTAL beyond a "could-not-proceed" note, since
nothing was audited. Re-request the pass once the branch contains the implementation (push it so it is
independently fetchable)._
