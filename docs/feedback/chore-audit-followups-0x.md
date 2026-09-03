## Feedback — chore/audit-followups-0x

### Edge case
- The main repo checkout (`/Users/tiagocruz/Desktop/Claude/dex-aggregator 2`) lost its `.git`
  directory entirely mid-session, breaking every linked worktree on the machine (including
  the one this branch started in). Recovered by cloning `origin/main` fresh into
  `~/ts-worktrees/chore-audit-followups-0x-fresh`, copying over the 5 already-edited files, and
  committing/pushing from there. Full suite (259 files / 3706 tests) reran green in the fresh
  clone to confirm the earlier 1 failing test (`check-bash3-compat.test.mjs` /
  `grok-dispatch.test.mjs`) was caused by the broken `.git`, not this change. The original
  worktree and the pre-existing sibling worktrees under `~/ts-worktrees/` are still broken and
  need investigation independent of this branch.

### Rewritten comment (Task 1, verbatim)
```
//   - '0x'      ARMED, but an anomaly tripwire, not proof the fee was
//               taken. Tolerance is a ONE-SIDED +2% ceiling (api.ts
//               validateFeeIntegrity) against 0x's own 10 bps
//               (FEE_BPS) fee — dropping that fee raises the output
//               only ~0.1%, ~20x inside the 2% band, so the check
//               cannot detect a dropped fee, symmetric or asymmetric.
//               It only catches gross anomalies far past that band.
```

### New rejection reasons (Tasks 2 & 3)
- `AllowanceHolder exec operator ${operator} does not match target ${target}` — Task 2, ADR-022
  interim `operator === target` narrowing.
- `AllowanceHolder exec inner execute() carries a zero minAmountOut` — Task 3, nested amount
  integrity guard.

### Citation grep (Task 4)
```
src/lib/constants.ts:176:// never both (src/lib/adapters/partner-fee-invariant.test.ts).
src/lib/fee-mode.ts:27: * (src/lib/adapters/partner-fee-invariant.test.ts), and every FEE_NATIVE source is also
```
No bare-filename citation of `partner-fee-invariant.test.ts` remains in either file.

### Acceptance results
1. `operator !== target` REJECTED with the new distinct reason even with both individually
   whitelisted (`velora` operator against the whitelisted 0x target) — PASS. `operator ===
   target` on the golden vector still passes — PASS. (Negative control: this check did not
   exist before this branch, so `operator !== target` would have passed on origin/main.)
2. `minAmountOut === 0` REJECTED with its own reason — PASS. `> 0` accepted — PASS. Golden
   vector (`minAmountOut` non-zero) unaffected — PASS.
3. Grep proof above — PASS, no bare-filename citation remains.
4. Full suite: 259 files / 3706 tests green. Lint: 0 errors / 94 warnings (same ceiling as
   before this branch — all pre-existing, none in the touched files). Typecheck: clean.

### Behaviour for a healthy swap
None of this changes behaviour for a healthy swap: Task 1 is comment-only, Tasks 2 and 3 only
reject shapes that were never produced by the observed 0x mainnet path (operator always equals
target, minAmountOut is always non-zero in real quotes), and Task 4 is citation text only.
