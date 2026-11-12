# fix/stabilise-slow-tests — feedback
- [x] 1 times · [x] 2 cause + diff · [x] 3 loaded runs, gates, compare link

## 1. Times (ms; machine at load ~11 already, so min/median/max of N runs)
| test | alone before | suite before | alone after | suite after |
|---|---|---|---|---|
| narrative-contrast, each of 7 heavy | ~1000 | 2309–2942 | file total ≤ 5 | all < 30 |
| narrative-contrast, file tests phase (hooks incl.) | 7.3–7.8 s | – | 0.56–0.60 s | – |
| sounds-parity, first test | 1109 / 1127 / 2244 | 1652 | 104 / 116 / 155 | 252 |
| sounds-parity, other 9 | 25–55 | 86–259 | 25–65 | 68–199 |
| sounds-parity, file tests phase | 1.6–2.3 s | – | 1.7–2.4 s (same) | – |

## 2. Cause and fix
- **narrative-contrast:** photos are decoded once; the repeat is `p95(scrimmedLuminances)` (composite + sort of 20k px per state × section) in 7 tests. Fix: memo per (state, α) filled in `beforeAll`, `Float64Array` sort. Report (`TS_CONTRAST_OUT`, 16 lines) byte-identical. No per-file timeout.
- **sounds-parity:** nothing waits; the cost is ONE cold load of the shell tree (~1.1–1.5 s, CPU profile: `node:fs` reads), billed to test 1. Discarded: stub `darkTheme` (no gain), mock 5 tab bodies (979 vs 1127, noise, weaker). Fix: `beforeAll(freshPage, 20_000)`. File total not faster; the risk is isolated.
- Diff: contrast +27/−8, parity +8/−1; no assertion, threshold, photo, global config or CI touched.

## 3. Loaded runs and gates
- 3 suites beside a `npm run build` loop (46 builds, load 13–17): 471 files, 10368 tests, 0 failed (134/134/149 s; unloaded 124–130 s). Slowest test / sum, contrast: 1/5, 2/6, 2/11 ms; parity: 375/1830, 194/1064, 666/2437 ms.
- Extra: 20 busy loops, 2 runs: original slowest 4254–4288 ms (near 5 s, **did not time out — CI failure not reproduced**); fixed ≤ 2 / ≤ 360 ms.
- `tsc` 0; eslint 92 warnings before and after (delta 0); `gen-claude-state.mjs --check` current; diff 3 files +57/−9.
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/stabilise-slow-tests (no PR)

## Notes
- `goal-lint` FAIL: `control-line` only (goal text has no `CONTROL:`); not edited.
- Late reads: `photos/{contrast,photo-tokens,narrative}.ts`, `landing/narrative.ts`, `tokens.ts`, `shell.test.tsx`, `agent-verify.sh`. `composite`/`luminance` pure, `State.px` never mutated → memo cannot go stale.
- Premises false (no re-decode; nothing waits). Asked only after the push (should have been before); owner: **keep as pushed**.
- Sibling `sounds-parity.swap.test.tsx` has the same cold-first-test shape (932 / 379 ms); out of scope.
