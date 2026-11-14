# feat/basket-selection-module — FEEDBACK (no PR; Auditor before the keeper wiring builds on it)

Goal: the Basket DCA selection rules (spec §4, §4a; ADR-027) as a PURE keeper module, pinned pick for pick by vectors
exported from the analyst's engine. Nothing imports the module; keeper files, contracts, API and UI are untouched.
Long tables (vectors, spec-vs-engine with engine lines, mutation names): `feat-basket-selection-module.evidence.md`.

## Checklist
- [x] Commit 1 `9bb0e9d`: `scripts/basket-dca/export_vectors.py` + `contracts/order-engine/executor/fixtures/basket-dca/*.json` (engine sha256 in every header)
- [x] Commit 2 `ecca0d9`: `contracts/order-engine/executor/basket-scheduler.js` (`chooseN`, `kSoft`, `legAmounts`, `decideTick`)
- [x] Commit 3 `df738de`: `basket-scheduler.test.mjs` (replay, soft/rigid ends, beyond-engine cases, seeded property test); CLAUDE.md state block (keeper test files 52 -> 53) + AGENTS.md pin
- [x] Mutation proof in a scratch copy: 15 of 15 killed (cooldown, k_soft window, 2-per-leg limit, band_add, tie-break, ...)
- [x] Verify: `scripts/agent-verify.sh --keeper --codeql` RED on 2 fiat tests that are main's, not this branch's (§5); `gen-claude-state --check` current
- [x] Push, compare link. Asked once (red verify outside the diff, rule 11); the owner, 2026-11-14: "Push now" (the two
  fiat failures stay recorded in §5 as main's)

## 1 Engine and vectors
`engine_discrete.py` sha256 `282581bab72abf16b19096ab0f1be15e50fe0f2b5cdd3a3a7e165d9f2f281685` (pinned in the exporter and
the test), run with L = 2, Hamilton, k_soft = max(1, ceil(N/4)), 3 grace ticks, pd0 null; Python 3.14.2 + numpy 2.5.4 in
a venv outside the repo. 72 run vectors (52 soft / 20 rigid, 1 694 ticks, 1 152 first chunks + 55 catch-ups, 17 unbought
chunks): calm 20 (4 splits x N 6/9/12/26/86), fall 9, no-price 4, band 3, min-fill 6, ties 6, mixed 24; choose-n 148 (every
case of the engine tests); rounding 290 (85 exact halfway points). `--check` regenerates all nine files identically.

## 2 Spec versus engine (the module follows the engine; lines in the evidence file)
a. Nothing due and every leg complete: "complete", not "calendar" (§4.10 lists calendar first).
b. Rule 5 never empties a tick (it reorders only >= 2 eligible legs): the engine's "rule 5" idle reason is unreachable.
c. Catch-up: "furthest behind" counts the tick's own picks, and its variation tie is RAW; only the first-chunk sort
   rounds to 12 decimals. d. Last tie in both sorts: lower leg (spec silent).
e. The 12-decimal rounding is numpy's (rint, half to even), not Python's `round()`: they differ on 35 of 290 values.
f. Band edge in doubles: at 1%, 0.99 and 1.01 are OUT (`|p - 1|` = 0.010000000000000009); a decimal reading of §4a says in.
g. "v = 0 at tick 0" (§4.2) holds for any leg without a previous price, at any tick.
h. §3.3 minFill is per leg's route; the engine and `chooseN` take one value (see Findings).

## 3 Tests
`basket-scheduler.test.mjs`: 162 tests in 15 suites. Node 20.20.2: 162 pass, 0 fail, 0 cancelled; Node 22.23.5: same.
Whole keeper suite (agent-verify): Node 20 1402 pass / 0 fail / 0 cancelled, Node 22 1402 / 0 / 0 (1240 before + 162).
Node 20.20.2 and 22.23.5 are the official darwin tarballs (sha256 checked against SHASUMS256.txt) in a scratch NVM_DIR.

## 4 Mutation proof
15 mutants in a scratch copy (Node 22), all killed; failing names per mutant in the evidence file. E.g. rule 5 off: 49
replays + the not-executed test; k_soft window a tick late: `fall-n9-leg1-stays-soft`, `fall-n26-leg2-stays-soft`, 3 mixed;
2-per-leg -> 3: 4 replays + the property test; band_add ignored: `band-n12-stable2-b100-soft` + the property test.

## 5 Verify
`scripts/agent-verify.sh --keeper --codeql` @ `df738de` (base origin/main `130f2dd`): **RESULT: FAIL (1 failed)**.
suite 10630 passed / **2 failed**, 494 files · lint-delta +0/+0 · tsc 0 errors · build ok · v1v2-parity 111/0 · rpc-budget
36/0 · codeql security-extended head 13, base 13, new 0 · keeper node20 1402/0/0, node22 1402/0/0.
**The 2 failures are main's:** `src/ui/v2/fiat/fiat.test.tsx` ("a payload that was fresh when fetched but has since aged
out…", "a rate that was fresh when loaded flips to dollars…"), real-clock EUR tests red on a Saturday (2026-11-14). The
same 2 fail on the main checkout (`7e566fd`, `src/ui/v2/fiat` identical to origin/main): 2 failed / 20 passed. This
branch touches no file under `src/`. The fix (a pinned weekday clock) is pushed on `chore/tooling-leftovers-2026-11`
(`0188776`), not merged.
`node scripts/gen-claude-state.mjs --check`: "CLAUDE.md state block is current" (keeper 53); AGENTS.md parity OK.
`export_vectors.py --check`: "same" for all nine fixtures. `git diff --stat origin/main...HEAD` before this commit: 16
files, 10108 insertions, 2 deletions (fixtures 8438, exporter 672, test 477, module 329, feedback 190, CLAUDE.md and
AGENTS.md one line each).
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/basket-selection-module

## Findings
- Edge (wiring goal): `next.cooldown` is the first PICKED leg (§4.9 "picked"), also when its chunk did not execute; §4's
  state line says "took". The wiring chooses which one it persists. A missed tick (§6, keeper down) is decided from the
  state given: `last` then spans the gap.
- Edge (wiring goal): the §5 journal wants each leg's variation and eligibility reason; `decideTick` returns the goal's
  shape only (`picks`, `idleReason`, `next`). An additive per-leg diagnostic is a small follow-up.
- Edge (API goal): with mixed routes (3 and 16 USD) call `chooseN` once per minFill and take leg i from the call made with
  leg i's value (the cap is per leg, Hamilton ignores minFill), or widen the signature.
- Note: soft mode completes only if every leg has a price, in band, in the soft window and grace (the engine's own test
  excludes rule 9 only). The soft vectors are built that way (goal: soft ends done == n).
- Note: the half-up rounding mutant dies only on the numpy table: no run vector lands on an exact 12th-decimal halfway.
- Process: the first mutation run left band_add pinned by the property test alone and "band before no price" alive; the
  band vectors were rebuilt (counterfactual engine runs in the exporter) and folded into commit 1, local history, before
  any push.
- Not checked: numpy with Sonatype (its MCP server failed to connect, token expired). numpy lives only in the scratch venv.
- Further reads: ADR-027; analyst `scenarios.py` (SPLITS), `experiments_v32.py` (COMBOS, k_rec), `tests/test_engine_v32.py`;
  `scripts/gen-claude-state.mjs`, `scripts/agent-verify.sh`; style from `submission-policy.js` + its test.
