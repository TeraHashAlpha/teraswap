# feat/basket-selection-reference — FEEDBACK (no PR; Draft PR + Auditor required: keeper selection logic)

Goal: the Basket DCA selection module takes a price REFERENCE recorded at creation (owner decision 2026-11-16), as the
analyst's runs do (a real `pd0`), and returns per leg the values it decided with. Still a pure module that nothing
imports; other keeper files, contracts, API and UI untouched. Long tables: `feat-basket-selection-reference.evidence.md`.

## Owner answers (asked once, 2026-11-16; they supersede the goal text)
1. **Rule 9's entry.** The goal says the reference sets `last` and `entry` and calls that "the engine with pd0". The
   engine does not: `pd0` gives `last` only (`engine_discrete.py:64`), and `entry` is the leg's first TICK with a price
   (`:71`). Measured on the unedited engine (rigid, 25%, reference 100/100/100, leg 0 at 70 from the first cycle): the
   engine takes entry 70, does not protect leg 0, buys it first, ends 2/2/2; the module given last = entry = 100
   protects it (70 <= 75) and ends 0/2/2. Owner: **follow the engine**. The reference gives `last` only; the state at
   the first tick is `{ last: reference, entry: null }`.
2. **Model.** CONTROL says Opus; the session was set to Fable 5.2 just before the goal. Owner: run here, on Fable 5.2.

## Checklist
- [x] Commit 1 `8ca34bc2`: vectors with a real reference (`export_vectors.py`, fixtures, the engine copy + sha256, this file)
- [x] Commit 2 `5a486caa`: the module (`decideTick` with a reference, `perLeg`, index validation, Infinity, zero amount, JSDoc)
- [x] Commit 3 `cf79894a`: tests (replay + per-leg values against the engine, reference and no-reference first picks, edges)
- [x] Mutation proof in a scratch copy: 33 of 33 killed (the goal's four in 7 forms, 11 on the new behaviour, the first goal's 15)
- [x] Verify: `scripts/agent-verify.sh --keeper --codeql` **RESULT: PASS**, 8 of 8 checks; `gen-claude-state --check` current (§5)
- [x] Push `feat/basket-selection-reference`, compare link (§5)

Commits 1 and 2 are red on their own by the goal's split (the old test replays the new vectors with the old state); the
head is green. `origin/main` moved during the work (PRs #693, #698, #699, #696): the three commits, never pushed, were
rebased onto `c23cec40`, no conflict, and everything in §3 and §5 was measured after that.

## 1 Engine and vectors
`engine_discrete.py` sha256 `282581bab72abf16b19096ab0f1be15e50fe0f2b5cdd3a3a7e165d9f2f281685`, now copied byte for byte
to `contracts/order-engine/executor/fixtures/basket-dca/` with `engine_discrete.py.sha256` (`cmp` against the analyst's
file: identical; the test hashes the copy). Run with L = 2, Hamilton, k_soft = max(1, ceil(N/4)), 3 grace ticks and
pd0 = each vector's reference; Python 3.14.2 + numpy 2.5.4. **96 run vectors** (72 soft / 24 rigid, 2 047 ticks, 1 423
first chunks + 57 catch-ups, 25 unbought chunks): calm 20, fall 12, no-price 4, band 4, min-fill 6, ties 6, mixed 24,
no-reference 20; 68 with a reference on every leg, 16 on some, 12 on none. choose-n 148 and rounding 290 unchanged.
The tick prices of main's 72 vectors are unchanged (the reference has its own seed); it changes the first pick in 44
of them (12 of 20 calm). No reference, as before: the new module replays main's 72 old vectors with 0 differing, and
the 12 `noref-all-*` vectors are main's calm ones. `--check`: "same (bytes)" × 11, from the repo alone.

## 2 Spec versus engine (the module follows the engine; table in the evidence file)
k. **The reference is `last`, not `entry`** (answer 1): spec §4 "Reference" and its state line say it gives both.
l. A leg with no previous price ranks as 0 (spec and engine agree); the module returns `variation: null` for it.
m. Band edge: a sum EQUAL to the band is in band (`>`). At the four product bands no double price can make it equal.
n. Rule 9 edge: entry 1.2 at 25%, exactly 0.9 is NOT protected (1.2 × 0.75 = 0.8999999999999999) and the leg buys.
o. `picked`, `cooldown`, `not_due` are this module's names for an eligible leg; the engine has only its four blockers.
p. `protected` stays true in the soft window, where the leg may buy: "paused" is reason `rule9`, not `protected`.
q. "Buy now gives the first chunk to leg 0" holds for the first ELIGIBLE leg: not if leg 0 has no price at tick 0.

## 3 Tests
`basket-scheduler.test.mjs`: 323 tests in 18 suites (162 in 15 on main). Node 20.20.2: 323 pass, 0 fail, 0 cancelled;
Node 22.23.5: the same. Whole keeper suite: Node 20 1563 pass / 0 fail / 0 cancelled, Node 22 1563 / 0 / 0 (1 402 on main).

## 4 Mutation proof
33 mutants in a scratch copy (Node 22.23.5), each one exact string replacement, all killed; failing tests per mutant in
the evidence file. The goal's four: ignore the reference 144 failing (135 when only tick 0 ignores it); stale variation
161 (`last` never refreshed), 156 (against entry), 100 (a rounded value returned); band `>=` 3
(`band-edge-n9-stable2-b171-soft` replay and per-leg, and the band edge test); no Infinity check 1 (the not-finite
test). Also: entry seeded from the reference 98; the first goal's 15 mutants all still die.

## 5 Verify
`scripts/agent-verify.sh --keeper --codeql` @ `cf79894a` (base origin/main `c23cec40`): **RESULT: PASS**.
suite 10 814 passed / 0 failed, 502 files · lint-delta +0/+0 · tsc 0 errors · build ok · v1v2-parity 123/0 · rpc-budget
36/0 · codeql security-extended head 13, base 13, new 0 · keeper node20 1563/0/0, node22 1563/0/0.
The four `scripts/agent-verify.test.mjs` tests the goal names failed in the run before the rebase (10 796 / 4) and pass
now: PR #698, merged on main meanwhile, fixes them.
`node scripts/gen-claude-state.mjs --check`: "CLAUDE.md state block is current"; AGENTS.md parity OK.
`git diff --stat origin/main...HEAD` before this commit: 16 files, 5 487 insertions, 507 deletions (in the evidence file).
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/basket-selection-reference

## Findings
- Edge (wiring goal): derive `last` from the latest journal row with a price, the reference row included, and `entry`
  from the first TICK row with a price, the reference row excluded. `decideTick` throws on an `entry` at tick 0, which
  is that mistake; it cannot catch it at a later tick.
- Edge (wiring / API goal, item q): in "buy the first one now" mode the user's token is leg 0, but if it has no price
  at tick 0 the first chunk goes to the next leg. Refuse to create, or wait, when the chosen token has no price.
- Edge (wiring goal, item p): journal `reason` for the leg's state; `protected` alone does not mean "not bought".
- Edge: `cooldown` is not checked at tick 0 (the engine starts with none); a non-null one there is used as given.
- Spec (Architect): correct the two sentences of item k; the repo's `docs/Prompts/SPEC-BASKET-DCA.md` is the older
  text without the reference (sha256 `8a3cbc01…c37b` against the pack's `db68d328…12ed`).
- The goal says the module "forces variation 0 at the first tick". It had no such rule; the state did it: the engine's
  first-tick state `{ last, entry: null }` was refused ("last and entry are set together").
- Not done: a replay on the analyst's real positions (its `data/` and `results/` are empty on this machine, no pandas).
- Process: `scripts/agent-verify.sh` itself calls `brew --prefix node@N` (a read-only query) to find Node; nothing
  was installed. gitleaks 8.30.1, default rules, on a copy of the changed files (the repo config allowlists
  `contracts/order-engine/`): no leaks in 807 KB.
- Further reads: `experiments_v3x.py`, `experiments_v32.py`, `prices_v3.py` (grep for `pd0` only),
  `tests/test_engine_discrete.py:1-50`; `docs/Prompts/_PROMPT-TEMPLATE.md` §0-2, `.claude/agents/implementer.md`,
  `scripts/agent-verify.sh` (options, Node lookup), `codeql.yml`, `keeper-tests.yml`, `.gitleaks.toml` (greps).
