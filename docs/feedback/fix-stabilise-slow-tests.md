# fix/stabilise-slow-tests — feedback

- [x] 1 before/after, alone + in suite · [x] 2 cause + diff · [x] 3 three loaded runs, gates, compare link

## 1. Times (ms; machine already at load avg ~11, so min/median/max of N runs)
| test | alone before | in suite before | alone after | in suite after |
|---|---|---|---|---|
| narrative-contrast, each of 7 heavy tests | ~1000 (5 runs) | 2309–2942 | ≤ 5 (file total) | all < 30 |
| narrative-contrast, file `tests` phase incl. hooks | 7.3–7.8 s | — | 0.56–0.60 s | — |
| sounds-parity, first test | 1109 / 1127 / 2244 (7) | 1652 | 104 / 116 / 155 (7) | 252 |
| sounds-parity, other 9 tests | 25–55 | 86–259 | 25–65 | 68–199 |
| sounds-parity, file `tests` phase | 1.6–2.3 s | — | 1.7–2.4 s (unchanged) | — |

## 2. Cause and fix
- **narrative-contrast**: photos are decoded once (collection), not per test (goal premise was off; conservative reading kept). The repeat was `p95(scrimmedLuminances(px, α))` — composite + sort of 20 k pixels per (state, section) — recomputed by 7 tests (~1 s each alone, ~2.5 s in the suite, so 2× more load hits 5 s). Fix: `scrimmedP95` memo per (state, α), filled once in `beforeAll`; `scrimmedLuminances` sorts a `Float64Array` (native numeric sort) instead of `number[]` + comparator. Same pixels, same percentile: the 16-line `TS_CONTRAST_OUT` report is byte-identical before/after. No per-file timeout needed (hook ~0.5 s vs 10 s default).
- **sounds-parity**: nothing waits (no timers; repeat `freshPage()` ≈ 20 ms). The ~1.1–1.5 s is ONE cold load of the shell module tree (CPU profile: `node:fs` reads of externals under `runExternalModule`), billed to the first test. Tried and discarded: stub `darkTheme` (median 1127→1221), also mock the 5 tab bodies like `shell.test.tsx` (→979, inside noise, weaker coverage). Fix: `beforeAll(freshPage, 20_000)` — cold load paid once in a hook with an explicit budget (measured ~1.1–1.5 s idle); parity tests keep the 5 s default. File total is NOT faster; the risk is isolated, not removed.
- Diff: `narrative-contrast.test.ts` +27/−8, `sounds-parity.test.tsx` +8/−1. No assertion, threshold, photo, global config or CI file touched.

## 3. Under load and gates
- 3 full suites (`CI=true npx vitest run`) while `npm run build` looped (46 builds, all exit 0; load avg 13–17 vs ~11 idle): 471 files, 10368 tests, 0 failed each time. Suite 134 / 134 / 149 s (unloaded 124–130 s).

| run | narrative-contrast (19 tests) slowest / sum | sounds-parity (12 tests) slowest / sum |
|---|---|---|
| 1 | 1 ms / 5 ms | 375 ms / 1830 ms |
| 2 | 2 ms / 6 ms | 194 ms / 1064 ms |
| 3 | 2 ms / 11 ms | 666 ms / 2437 ms |
- The build loop is moderate load (incremental builds). Extra check: both files alone beside 20 busy loops (load 14–17), original vs fixed, 2 runs each: original slowest test 4254–4288 ms (narrative-contrast and sounds-parity, both within ~15 % of the 5 s limit, **did not time out here — I did not reproduce the CI failure**); fixed ≤ 2 ms and ≤ 360 ms.
- Gates on the fixed head: unfixed suite baseline also 10368/10368; `tsc --noEmit` exit 0; eslint 92 warnings before and after (delta 0, both files clean); `node scripts/gen-claude-state.mjs --check` → "state block is current".
- `git diff --stat origin/main...HEAD` (before this edit): 3 files, +57/−9 (feedback 22, narrative-contrast +27/−8, sounds-parity +8/−1).
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/stabilise-slow-tests (no PR opened; the owner opens it).

## Notes
- `goal-lint` FAILs only `control-line` (goal text has no `CONTROL:` first line); the goal text is the owner's, not edited.
- Sibling `sounds-parity.swap.test.tsx` has the same shape (first test 932 ms in one suite run, 379 in the other) — out of scope (other tests), not touched.
- Extra reads: `shell.test.tsx`, `scripts/agent-verify.sh`, a worker CPU profile.
- Helpers/fixtures read late (after the first push): `photos/contrast.ts`, `photos/photo-tokens.ts`, `landing/narrative.ts`, `tokens.ts`, `photos/narrative.ts`, the `photos/narrative/*` image list, `narrative.css`/`tokens.css` scrim lines. `composite`/`luminance` are pure, `V2_COLORS`/`PHOTO_TOKENS` are `as const`, nothing mutates `State.px` after build, so the (state, α) memo cannot go stale. `composite` allocates an array per pixel — that is the ~0.5 s unit cost that remains.
- Premise check (asked once, after the push — it should have been before): photos are not re-decoded per test, and sounds-parity has nothing that waits. Owner answer: **keep as pushed** (memo + `Float64Array` sort; cold load in a `beforeAll` with an explicit 20 s budget).
