# feat/basket-selection-module — FEEDBACK (no PR; Auditor before the keeper wiring builds on it)

Goal: the Basket DCA selection rules (spec §4, §4a; ADR-027) as a PURE keeper module, pinned pick for pick by vectors
exported from the analyst's engine. Nothing imports the module; keeper files, contracts, API and UI are untouched.

## Checklist
- [ ] Commit 1: `scripts/basket-dca/export_vectors.py` + `contracts/order-engine/executor/fixtures/basket-dca/*.json` (engine sha256 in every header)
- [ ] Commit 2: `contracts/order-engine/executor/basket-scheduler.js` (`chooseN`, `kSoft`, `legAmounts`, `decideTick`)
- [ ] Commit 3: `basket-scheduler.test.mjs`: replay, soft/rigid ends, beyond-engine cases, seeded property test; Node 20 and 22
- [ ] Mutation proof in a scratch copy: cooldown, k_soft window, 2-per-leg limit, band_add, tie-break
- [ ] Verify: `scripts/agent-verify.sh --keeper --codeql`; `node scripts/gen-claude-state.mjs --check`
- [ ] Push, compare link; evidence 1-5 below, long tables in `feat-basket-selection-module.evidence.md`

## Evidence
Filled in as each step lands.
