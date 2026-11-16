# feat/basket-selection-reference — FEEDBACK (no PR; Draft PR + Auditor: keeper selection logic)

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
- [ ] Commit 1: vectors with a real reference (`export_vectors.py`, fixtures, the engine copy + sha256, this file)
- [ ] Commit 2: the module (`decideTick` with a reference, per-leg values, index validation, Infinity, zero amount, JSDoc)
- [ ] Commit 3: tests (replay + per-leg fields against the engine, reference and no-reference first picks, edges)
- [ ] Mutation proof in a scratch copy (ignore the reference; stale variation; band `>=`; no Infinity check)
- [ ] Verify: `scripts/agent-verify.sh --keeper --codeql`; `node scripts/gen-claude-state.mjs --check`
- [ ] Push `feat/basket-selection-reference`, compare link

## Findings so far
- Spec: SPEC-BASKET-DCA §4 (architect pack, 2026-11-16) says the reference row "gives `last_i` and `entry_i` their
  first values" and defines `entry_i` as "the reference price". Per answer 1 both sentences are wrong against the
  engine: the reference gives `last_i`; `entry_i` is the decision price at the leg's first tick with a price, in both
  modes. For the Architect to correct. The repo's `docs/Prompts/SPEC-BASKET-DCA.md` is the older text (no reference).
- The goal says the module "forces variation 0 at the first tick". It has no such rule: it computes `price / last - 1`
  at any tick. What forced it was the state: the engine's first-tick state `{ last, entry: null }` was refused
  ("last and entry are set together"), so `last` could only be null there.
- Band edge: at the four product bands (1, 2, 5, 10%) no double price makes `|p - 1| + band_add` EQUAL the band
  (band_add 0, 0.001, 0.0025, 0.003, 0.005; 300 doubles each side of each edge), so `>` and `>=` cannot differ there.
  They differ at 74 of the 1 000 whole-bps bands up to 10% with band_add 0.003; the edge vector uses 171 bps with
  0.9859 and 1.0141.
