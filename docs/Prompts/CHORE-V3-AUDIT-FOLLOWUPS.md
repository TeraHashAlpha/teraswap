# CHORE-V3-AUDIT-FOLLOWUPS — close L-01/L-02 from AUDIT-V3-P1-EXECUTOR before the v3 deploy

> **Source:** AUDIT-V3-P1-EXECUTOR verdict 2026-07-09 (APPROVE-TO-MERGE, 0C/0H/0M/2L/2I on SHA `954c415`).
> Non-blocking findings, but the contract is **immutable post-deploy** → both land BEFORE V3-P4. Small delta on the
> merged v3; contract → Opus, and the PR stays UNMERGED until an Auditor **delta pass** (scope = this diff only)
> returns 0C/0H. SSH-signed; branch `chore/v3-audit-followups` off latest `origin/main` (post-P1-merge) in a
> dedicated worktree; 2 droppable commits.

## Requirements
1. **L-01 — revert on `hasFeed && fairOut == 0`.** In the floor path of `TeraSwapOrderExecutorV3.sol`: when the
   pair HAS a valid (fresh, sequencer-ok) feed but `_fairValueOut` computes 0, **revert** (new error, e.g.
   `OracleValueZero`) instead of falling through to the signed min. Genuine no-feed/stale semantics unchanged
   (→ signed min verbatim). Per ADR-013 N4: a zero fair-value on a live feed is an integrity failure, not a
   pricing opinion.
2. **L-02 — lift audit-flagged coverage to `executeOrder` level.** The decimals fuzz (6/8/18 × 8/18) and the four
   sequencer scenarios currently exercise only the `_fairValueOut` helper: re-express them through `executeOrder`
   end-to-end; add the (previously untested) `fairOut==0` branch test — mock a live feed into computing 0 →
   expect `OracleValueZero` after commit 1.

## Do NOT
No other contract changes (constants, nonces, routerDataHash, events untouched); no deploy; no frontend/keeper/API
(that is V3-P2, parallel); do not weaken any v2-parity guard.

## Files affected (read ONLY these + tests)
`contracts/order-engine/TeraSwapOrderExecutorV3.sol` (floor path only), its tests in
`contracts/order-engine/test/`, `docs/Prompts/CHORE-V3-AUDIT-FOLLOWUPS.md` (commit this spec). Reference:
the audit report (per-PR review on the P1 PR), ADR-013.

## Expected output
Branch + PR, CI green (push + report, don't poll), forge suite green with the new/lifted tests. FEEDBACK ≤1 screen:
the exact revert condition + which tests moved to executeOrder level. **Flag for Auditor delta pass (0C/0H) — do
NOT merge.**

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Opus · effort high · NO CI-poll (push + report, don't watch) · read ONLY the listed files · FEEDBACK <= 1 screen.

CHORE-V3-AUDIT-FOLLOWUPS per docs/Prompts/CHORE-V3-AUDIT-FOLLOWUPS.md (commit the spec in this PR). Branch chore/v3-audit-followups off origin/main (post-V3-P1 merge) in a DEDICATED worktree, SSH-signed, CI green. CONTRACT (fund-flow) -> PR stays UNMERGED until an Auditor DELTA pass (this diff only) returns 0C/0H. Contract is immutable post-deploy -> this lands BEFORE the V3-P4 deploy.

Source: AUDIT-V3-P1-EXECUTOR (2026-07-09, APPROVE-TO-MERGE 0C/0H/0M/2L/2I on 954c415) non-blocking findings L-01 + L-02.

Commits (droppable, in order):
1. L-01: in TeraSwapOrderExecutorV3.sol floor path — when the pair HAS a valid feed (fresh + sequencer-ok) but _fairValueOut computes 0, REVERT with a new error OracleValueZero instead of falling through to the signed min. Genuine no-feed/stale semantics UNCHANGED (-> scaled signed minAmountOut verbatim). Rationale (ADR-013 N4): zero fair-value on a live feed = integrity failure, never a silent downgrade to the weaker floor.
2. L-02: lift coverage to executeOrder level — the decimals fuzz (6/8/18 legs x 8/18 feed) and the four sequencer scenarios currently exercise only the _fairValueOut helper; re-express them end-to-end through executeOrder; ADD the fairOut==0 branch test (mock a live feed into computing 0 -> expect OracleValueZero revert per commit 1).

Do NOT: change anything else in the contract (constants, nonces, routerDataHash, events, MAX_ORDER_SLIPPAGE_BPS untouched); deploy; touch frontend/keeper/API (V3-P2 owns those, runs in parallel — disjoint files); weaken any v2-parity guard (recipient==owner, whitelist, reentrancy, balance-delta).

Files: contracts/order-engine/TeraSwapOrderExecutorV3.sol (floor path ONLY) + its tests in contracts/order-engine/test/ + docs/Prompts/CHORE-V3-AUDIT-FOLLOWUPS.md. Reference read-only: the audit review on the V3-P1 PR, docs/ADR/ADR-013-order-onchain-floor.md.

Expected: PR open, CI green (push + report, don't poll), full forge suite green incl. lifted/new tests. FEEDBACK <=1 screen in the PR body: exact revert condition + list of tests moved to executeOrder level. Flag for Auditor delta pass — do NOT merge.
```
