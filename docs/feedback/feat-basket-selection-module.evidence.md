# feat/basket-selection-module — evidence tables (companion of `feat-basket-selection-module.md`)

## 1 Engine and vectors by family

Engine: `engine_discrete.py` of the analyst package (basket-dca-v2, `docs-Reports-basket-dca/src`, v3.2), sha256
`282581bab72abf16b19096ab0f1be15e50fe0f2b5cdd3a3a7e165d9f2f281685`, pinned in `scripts/basket-dca/export_vectors.py`
(`ENGINE_SHA256`, the script stops on any other hash) and in `basket-scheduler.test.mjs`; written into every fixture
header. Executed from the exact bytes hashed, no bytecode written into the package. Run: `run_discrete(Pe = Pd, w = num/den,
C, n=None, min_fill, L=2, Pd, pd0=[nan, nan, nan], rPe = rPd = the 3 grace rows, dd = threshold, mode,
k_soft=lambda N: max(1, ceil(N/4)), rule='hamilton', stable_idx, band, band_add)`. Python 3.14.2, numpy 2.5.4, venv in
a scratch directory outside the repo. `export_vectors.py --check` regenerated all nine files identically ("same" x 9).

Sources of the choose-n cases (sha256, in `choose-n.json`): `tests/test_engine_discrete.py` `6a1a828c…cf66`,
`tests/test_engine_v32.py` `ab50d331…f451`, `src/experiments_v32.py` `0ae205f3…18e1` (COMBOS: 25 cadence × N pairs).

| family | vectors (soft / rigid) | ticks | fills: select + catch-up | idle ticks by reason | unbought chunks |
|---|---|---|---|---|---|
| calm | 20 (20 / 0) | 616 | 456 + 0 | calendar 96, complete 64 | 0 |
| fall | 9 (4 / 5) | 179 | 124 + 12 | complete 21, rule9 34 | 16 |
| no-price | 4 (3 / 1) | 71 | 57 + 2 | complete 10, no_price 4 | 0 |
| band | 3 (2 / 1) | 39 | 27 + 2 | band 2, complete 4, no_price 3, rule9 3 | 1 |
| min-fill | 6 (6 / 0) | 320 | 179 + 0 | calendar 112, complete 29 | 0 |
| ties | 6 (5 / 1) | 101 | 67 + 16 | complete 18, no_price 16 | 0 |
| mixed | 24 (12 / 12) | 368 | 242 + 23 | band 1, calendar 23, complete 73, no_price 29 | 0 |
| **total** | **72 (52 / 20)** | **1694** | **1152 + 55** | band 3, calendar 231, complete 219, no_price 52, rule9 37 | **17** |

Plus `choose-n.json`: 148 cases (48 of `test_chunks_respect_min_fill_and_hamilton_sum`, 100 of
`test_chosen_k_always_leaves_rule9_room_and_fits_every_chunk`) and k_soft for N = 1..100; `rounding.json`: 290 values of
`round(np.float64(v), 12)`, 85 exact halfway points, 35 where Python's `round()` gives another result.

Claims the exporter checks before writing (it stops when one fails): soft vectors complete with deviation < 1e-9 pp;
rigid ones report no k_soft; never more than 2 chunks of a leg per tick, nothing after the last grace tick; a protected
leg buys only in the soft window; rigid + never recovering leaves chunks; the N = 26 soft fall hits the 2-per-leg limit;
no fill on a tick without a price; holes on N − 1 and in grace; the stable never buys out of band; tick 4 of
`band-n12` is out only because of band_add and tick 5 (0.99) only by the float `|p − 1|`, and an engine re-run without
band_add, and one with 0.991 for 0.99, both change the picks; the priority vector has an idle tick for every pair of
no_price / band / rule9; every min-fill vector is capped except its uncapped contrast; ties vectors have catch-ups.

| id | weights | N | C / minFill | mode, threshold | stable, band | n | fills | unbought | notes |
|---|---|---|---|---|---|---|---|---|---|
| calm-25-25-50-n6 | 1/4 1/4 1/2 | 6 | 1000 / 16 | soft 0.25 | - | 2 1 3 | 6 | 0 0 0 | calm prices (each leg within 4% of its base) |
| calm-25-25-50-n9 | 1/4 1/4 1/2 | 9 | 1000 / 16 | soft 0.25 | - | 2 2 5 | 9 | 0 0 0 | calm |
| calm-25-25-50-n12 | 1/4 1/4 1/2 | 12 | 1000 / 16 | soft 0.25 | - | 3 3 6 | 12 | 0 0 0 | calm |
| calm-25-25-50-n26 | 1/4 1/4 1/2 | 26 | 1000 / 16 | soft 0.25 | - | 7 6 13 | 26 | 0 0 0 | calm |
| calm-25-25-50-n86 | 1/4 1/4 1/2 | 86 | 1000 / 16 | soft 0.25 | - | 15 15 31 | 61 | 0 0 0 | calm; minFill caps every leg |
| calm-40-40-20-n6 | 2/5 2/5 1/5 | 6 | 1000 / 16 | soft 0.25 | - | 3 2 1 | 6 | 0 0 0 | calm |
| calm-40-40-20-n9 | 2/5 2/5 1/5 | 9 | 1000 / 16 | soft 0.25 | - | 4 3 2 | 9 | 0 0 0 | calm |
| calm-40-40-20-n12 | 2/5 2/5 1/5 | 12 | 1000 / 16 | soft 0.25 | - | 5 5 2 | 12 | 0 0 0 | calm |
| calm-40-40-20-n26 | 2/5 2/5 1/5 | 26 | 1000 / 16 | soft 0.25 | - | 11 10 5 | 26 | 0 0 0 | calm |
| calm-40-40-20-n86 | 2/5 2/5 1/5 | 86 | 1000 / 16 | soft 0.25 | - | 25 25 12 | 62 | 0 0 0 | calm; capped |
| calm-33-33-33-n6 | 1/3 1/3 1/3 | 6 | 1000 / 16 | soft 0.25 | - | 2 2 2 | 6 | 0 0 0 | calm |
| calm-33-33-33-n9 | 1/3 1/3 1/3 | 9 | 1000 / 16 | soft 0.25 | - | 3 3 3 | 9 | 0 0 0 | calm |
| calm-33-33-33-n12 | 1/3 1/3 1/3 | 12 | 1000 / 16 | soft 0.25 | - | 4 4 4 | 12 | 0 0 0 | calm |
| calm-33-33-33-n26 | 1/3 1/3 1/3 | 26 | 1000 / 16 | soft 0.25 | - | 9 9 8 | 26 | 0 0 0 | calm |
| calm-33-33-33-n86 | 1/3 1/3 1/3 | 86 | 1000 / 16 | soft 0.25 | - | 20 20 20 | 60 | 0 0 0 | calm; capped |
| calm-30-30-40-n6 | 3/10 3/10 2/5 | 6 | 1000 / 16 | soft 0.25 | - | 2 2 2 | 6 | 0 0 0 | calm |
| calm-30-30-40-n9 | 3/10 3/10 2/5 | 9 | 1000 / 16 | soft 0.25 | - | 3 3 3 | 9 | 0 0 0 | calm |
| calm-30-30-40-n12 | 3/10 3/10 2/5 | 12 | 1000 / 16 | soft 0.25 | - | 4 3 5 | 12 | 0 0 0 | calm |
| calm-30-30-40-n26 | 3/10 3/10 2/5 | 26 | 1000 / 16 | soft 0.25 | - | 8 8 10 | 26 | 0 0 0 | calm |
| calm-30-30-40-n86 | 3/10 3/10 2/5 | 86 | 1000 / 16 | soft 0.25 | - | 18 18 25 | 61 | 0 0 0 | calm; capped |
| fall-n9-leg1-stays-soft | 2/5 2/5 1/5 | 9 | 1000 / 16 | soft 0.25 | - | 4 3 2 | 9 | 0 0 0 | leg 1 at 0.679-0.700 × entry from tick 1, never recovers |
| fall-n9-leg1-stays-rigid | 2/5 2/5 1/5 | 9 | 1000 / 16 | rigid 0.25 | - | 4 3 2 | 6 | 0 3 0 | same prices, rigid |
| fall-n9-leg1-recovers-soft | 2/5 2/5 1/5 | 9 | 1000 / 16 | soft 0.25 | - | 4 3 2 | 9 | 0 0 0 | recovers to 0.95-0.99 × entry at tick 6 |
| fall-n9-leg1-recovers-rigid | 2/5 2/5 1/5 | 9 | 1000 / 16 | rigid 0.25 | - | 4 3 2 | 9 | 0 0 0 | same prices, rigid |
| fall-n26-leg2-stays-soft | 1/4 1/4 1/2 | 26 | 1000 / 16 | soft 0.25 | - | 7 6 13 | 26 | 0 0 0 | leg 2 from tick 1, never recovers; catch-up at the 2-per-leg limit |
| fall-n26-leg2-stays-rigid | 1/4 1/4 1/2 | 26 | 1000 / 16 | rigid 0.25 | - | 7 6 13 | 13 | 0 0 13 | same prices, rigid |
| fall-n26-leg2-recovers-soft | 1/4 1/4 1/2 | 26 | 1000 / 16 | soft 0.25 | - | 7 6 13 | 26 | 0 0 0 | recovers at tick 16 |
| fall-n26-leg2-recovers-rigid | 1/4 1/4 1/2 | 26 | 1000 / 16 | rigid 0.25 | - | 7 6 13 | 26 | 0 0 0 | same prices, rigid |
| fall-boundary-n12-leg0-rigid | 1/3 1/3 1/3 | 12 | 1000 / 16 | rigid 0.25 | - | 4 4 4 | 12 | 0 0 0 | entry 4.0: 3.0 (= entry × 0.75) protected, 3.000001 not |
| noprice-n12-leg1-soft | 3/10 3/10 2/5 | 12 | 1000 / 16 | soft 0.25 | - | 4 3 5 | 12 | 0 0 0 | leg 1 no price at 3-5, 11 (N − 1), 13 (grace) |
| noprice-n9-leg0-start-soft | 1/3 1/3 1/3 | 9 | 1000 / 16 | soft 0.25 | - | 3 3 3 | 9 | 0 0 0 | leg 0 no price at 0-1 (entry later), 8 (N − 1), 9 (grace) |
| noprice-n26-all-soft | 2/5 2/5 1/5 | 26 | 1000 / 16 | soft 0.25 | - | 11 10 5 | 26 | 0 0 0 | no leg priced at 10-11; leg 2 none at 25 (N − 1), 27 (grace) |
| noprice-n12-leg2-rigid | 1/4 1/4 1/2 | 12 | 1000 / 16 | rigid 0.25 | - | 3 3 6 | 12 | 0 0 0 | leg 2 no price at 0, 5-7, 11, 12, 14 |
| band-n12-stable2-b100-soft | 1/4 1/4 1/2 | 12 | 1000 / 16 | soft 0.25 | leg 2, 0.01 | 3 3 6 | 12 | 0 0 0 | 0.971 out; 0.992 out only with band_add 0.003; 0.99, 1.01 out (float); out on N − 1 and a grace tick |
| band-n9-stable0-b500-soft | 2/5 2/5 1/5 | 9 | 1000 / 16 | soft 0.25 | leg 0, 0.05 | 4 3 2 | 9 | 0 0 0 | 0.96 + 0.003 and 1.047 + 0.003 in; 0.948, 1.06, 0.94 out; 0.95 out (float) |
| band-n9-priority-rigid | 1/4 1/4 1/2 | 9 | 1000 / 16 | rigid 0.25 | leg 2, 0.01 | 2 2 5 | 8 | 1 0 0 | leg 0 rule 9 from tick 1; leg 1 no price at 2-3; stable out at 2-3, 5, 9, no price at 7 |
| minfill-c100-m16-n12 | 1/4 1/4 1/2 | 12 | 100 / 16 | soft 0.25 | - | 1 1 3 | 5 | 0 0 0 | capped to (1, 1, 3) |
| minfill-c250-m16-n86 | 2/5 2/5 1/5 | 86 | 250 / 16 | soft 0.25 | - | 6 6 3 | 15 | 0 0 0 | every leg capped |
| minfill-c30-m3-n26 | 1/3 1/3 1/3 | 26 | 30 / 3 | soft 0.25 | - | 3 3 3 | 9 | 0 0 0 | canonical-route minFill, capped |
| minfill-c1000-m16-n86 | 1/4 1/4 1/2 | 86 | 1000 / 16 | soft 0.25 | - | 15 15 31 | 61 | 0 0 0 | capped, M < N |
| minfill-c20-m16-n6 | 3/10 3/10 2/5 | 6 | 20 / 16 | soft 0.25 | - | 1 1 1 | 3 | 0 0 0 | every cap max(1, 0) = 1 |
| minfill-c1000-m3-n86 | 1/4 1/4 1/2 | 86 | 1000 / 3 | soft 0.25 | - | 22 21 43 | 86 | 0 0 0 | uncapped contrast: the Hamilton split of 86 |
| ties-flat-n12-thirds | 1/3 1/3 1/3 | 12 | 1000 / 16 | soft 0.25 | - | 4 4 4 | 12 | 0 0 0 | constant prices, no price at 4-5: tie-breaks only |
| ties-flat-n9-25-25-50 | 1/4 1/4 1/2 | 9 | 1000 / 16 | soft 0.25 | - | 2 2 5 | 9 | 0 0 0 | constant prices, no price at 2-3 |
| ties-common-n26-30-30-40 | 3/10 3/10 2/5 | 26 | 1000 / 16 | soft 0.25 | - | 8 8 10 | 26 | 0 0 0 | one common move per tick, unrounded; no price at 5, 6, 15 |
| ties-common-n12-40-40-20 | 2/5 2/5 1/5 | 12 | 1000 / 16 | rigid 0.25 | - | 5 5 2 | 12 | 0 0 0 | common move; no price at 3, 4 |
| ties-common-n9-thirds | 1/3 1/3 1/3 | 9 | 1000 / 16 | soft 0.25 | - | 3 3 3 | 9 | 0 0 0 | common move; no price at 2, 3 |
| ties-common-n15-thirds | 1/3 1/3 1/3 | 15 | 1000 / 16 | soft 0.25 | - | 5 5 5 | 15 | 0 0 0 | common move; no price at 1-3, 7-8 |
| mixed-00 … mixed-23 | 4 splits | 6-26 | 100-5000 / 3 or 16 | soft (even) / rigid (odd), 0.1-0.4 | none or leg 0-2, 0.01-0.1 | | 4-26 | 0 | seeded ("mixed/j"): missing prices, dark ticks, up to two falls, stable excursions; soft ones keep window + grace priced and in band |

## 2 Spec versus engine (engine lines of `engine_discrete.py`; the module follows the engine)

| # | spec | engine | pinned by |
|---|---|---|---|
| a | §4.10: "calendar (nothing due), all complete, …" | nothing due AND every leg complete → `regra 6` = complete (:108) | the 219 idle "complete" ticks |
| b | §4.10 lists rule 5 as an idle reason | rule 5 reorders only with ≥ 2 eligible legs (:93), so a tick with chunks due and an eligible leg always picks: `regra 5` (:111) is unreachable | property test (never `rule5`) |
| c | §4.7 catch-up: furthest behind (tie: lowest v) | the ratio counts this tick's picks, `(n − done − picked) / n`, and the tie is on the RAW variation; only the first-chunk sort rounds to 12 decimals (:92 vs :100) | ties-common (mutations 9, 11) |
| d | silent on the last tie | lower leg: `sorted` is stable (:92), `max` keeps the first maximum (:100) | ties-flat, calm (mutations 8, 10) |
| e | goal: "same 12-decimal rounding" | numpy `round(np.float64, 12)` = `rint(v × 1e12) / 1e12`, half to even; Python's `round()` differs on 35 of 290 | rounding.json (mutation 12) |
| f | §4a: out when `|p − 1| + threshold > band` | in doubles 0.99 and 1.01 are OUT at 1% (`|p − 1|` = 0.010000000000000009), 0.95 OUT at 5%; a decimal reading says in | band-n12 tick 5 (re-run with 0.991 changes the picks) |
| g | §4.2: at tick 0 every v is 0 | v = 0 for ANY leg without a previous price, at any tick (:72, :92) | noprice-n9-leg0-start-soft |
| h | §3.3: minFill per leg's route, 3 or 16 USD | `choose_n` takes one `min_fill` (:38) | n/a: API goal |
| i | §4.5 `ceil(M(t+1)/N)`; §3.2 `floor(w·N)`, `floor(w·C/minFill)` | `− 1e-9` / `+ 1e-9` guards (:84, :35, :38), weights as doubles: same integers for N < 10^9 and the product splits | all vectors |
| j | n/a | options the module refuses: `dd=None` (rule 9 off), `min_fill` 0 (no cap), not 3 legs | invalid-input tests |

## 4 Mutation proof (scratch copy outside the repo: module + test + fixtures; Node 22.23.5)

Each mutation is one exact string replacement in a copy of `basket-scheduler.js` (the runner refuses a pattern that does
not match exactly once); the unmutated copy passes 162 / 0. Failing leaf tests, as node:test names them:

| # | mutation | failing / passing | failing tests |
|---|---|---|---|
| 1 | cooldown: rule 5 never moves the previous first leg back | 50 / 112 | `calm-25-25-50-n6 replays pick for pick`; `calm-25-25-50-n12 …`; `calm-25-25-50-n26 …`; `calm-25-25-50-n86 …`; `calm-40-40-20-n9 …`; `calm-40-40-20-n26 …`; … 44 more |
| 2 | cooldown: next.cooldown always null | 51 / 111 | `calm-25-25-50-n6 replays pick for pick`; `calm-25-25-50-n12 …`; `calm-25-25-50-n26 …`; `calm-25-25-50-n86 …`; `calm-40-40-20-n9 …`; `calm-40-40-20-n26 …`; … 45 more |
| 3 | k_soft window starts one tick late (`t > N − k`) | 5 / 157 | `fall-n9-leg1-stays-soft replays pick for pick`; `fall-n26-leg2-stays-soft …`; `mixed-06-soft …`; `mixed-10-soft …`; `mixed-16-soft …` |
| 4 | k_soft = floor(N / 4) | 44 / 118 | `calm-25-25-50-n6 replays pick for pick`; `calm-25-25-50-n9 …`; `calm-25-25-50-n26 …`; `calm-25-25-50-n86 …`; `calm-40-40-20-n6 …`; `calm-40-40-20-n9 …`; … 38 more |
| 5 | 2-per-leg limit → 3 | 5 / 157 | `fall-n26-leg2-stays-soft replays pick for pick`; `fall-n26-leg2-recovers-soft …`; `fall-n26-leg2-recovers-rigid …`; `ties-flat-n9-25-25-50 …`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked` |
| 6 | band_add ignored | 2 / 160 | `band-n12-stable2-b100-soft replays pick for pick`; `never over 2 picks per leg per tick, …` |
| 7 | tie-break, first chunk: least behind first | 6 / 156 | `ties-flat-n12-thirds replays pick for pick`; `ties-flat-n9-25-25-50 …`; `ties-common-n26-30-30-40 …`; `ties-common-n12-40-40-20 …`; `ties-common-n9-thirds …`; `ties-common-n15-thirds …` |
| 8 | tie-break, first chunk: higher leg wins the last tie | 75 / 87 | `calm-25-25-50-n6 replays pick for pick`; `calm-25-25-50-n9 …`; `calm-25-25-50-n12 …`; `calm-25-25-50-n26 …`; `calm-25-25-50-n86 …`; `calm-40-40-20-n6 …`; … 69 more |
| 9 | tie-break, catch-up: highest variation first | 6 / 156 | `ties-common-n26-30-30-40 replays pick for pick`; `ties-common-n12-40-40-20 …`; `ties-common-n9-thirds …`; `ties-common-n15-thirds …`; `mixed-10-soft …`; `mixed-20-soft …` |
| 10 | tie-break, catch-up: the last maximal leg wins | 6 / 156 | `ties-flat-n12-thirds replays pick for pick`; `ties-flat-n9-25-25-50 …`; `ties-common-n9-thirds …`; `ties-common-n15-thirds …`; `mixed-19-rigid …`; `a picked chunk that did NOT execute is due again next tick (the calendar counts executed chunks)` |
| 11 | raw variation in the first-chunk sort (no 12-decimal rounding) | 3 / 159 | `ties-common-n26-30-30-40 replays pick for pick`; `ties-common-n12-40-40-20 …`; `ties-common-n15-thirds …` |
| 12 | rounding half up instead of half to even | 1 / 161 | `290 cases, 85 exact halfway points, 35 where Python's round() differs` |
| 13 | rule 9 with `<` instead of `<=` | 2 / 160 | `fall-boundary-n12-leg0-rigid replays pick for pick`; `never over 2 picks per leg per tick, …` |
| 14 | idle priority: band before no price | 1 / 161 | `band-n9-priority-rigid replays pick for pick` |
| 15 | done counts the picks as executed | 137 / 25 | `calm-25-25-50-n6 replays pick for pick`; `calm-25-25-50-n9 …`; `calm-25-25-50-n12 …`; `calm-25-25-50-n26 …`; `calm-25-25-50-n86 …`; `calm-40-40-20-n6 …`; … 131 more |

First run (before the band vectors were rebuilt): 14 of 15 killed, but band_add only by the property test (no vector
depended on it) and "band before no price" survived. The rebuilt band family (counterfactual checks in the exporter)
pins both by vector.
