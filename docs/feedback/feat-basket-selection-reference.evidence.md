# feat/basket-selection-reference — evidence tables (companion of `feat-basket-selection-reference.md`)

## 1 Engine and vectors by family

Engine: `engine_discrete.py` of the analyst package (basket-dca-v2, `docs-Reports-basket-dca/src`, v3.2), sha256
`282581bab72abf16b19096ab0f1be15e50fe0f2b5cdd3a3a7e165d9f2f281685`. Now kept in the repo, byte for byte, at
`contracts/order-engine/executor/fixtures/basket-dca/engine_discrete.py`, with `engine_discrete.py.sha256` beside it
(`shasum -a 256 -c engine_discrete.py.sha256` → `engine_discrete.py: OK`). `cmp` of the copy against the analyst's file:
identical; `export_vectors.py --check --analyst-src <the analyst's src/>` prints "engine_discrete.py is byte-identical to
the in-repo copy; 3 choose-n sources match their pinned sha256". The same sha256 is pinned in the exporter
(`ENGINE_SHA256`, any other hash stops it), in the test (which hashes the copy itself) and in every fixture header.

Run: `run_discrete(Pe = Pd, w = num/den, C, n=None, min_fill, L=2, Pd, pd0 = the vector's reference (nan where null),
rPe = rPd = the 3 grace rows, dd = threshold, mode, k_soft=lambda N: max(1, ceil(N/4)), rule='hamilton', stable_idx,
band, band_add)`, the call of `experiments_v31.py:39` with `pd0 = D[0]`, the decision prices of the row before the
first cycle (`experiments_v3x.py:67`, `:141`). Python 3.14.2, numpy 2.5.4, a venv in a scratch directory outside the
repo (made by an earlier session; nothing was installed in this one). The engine is executed from the hashed bytes and
never edited: the per-tick values are read from `run_discrete`'s own locals with `sys.settrace`, at two lines found by
their text (`took = np.zeros(Lg, int)`, line 90: usable, entry, v, prot, sblock, due, cooldown and `why_not(i)`;
`if cooldown in order and len(order) > 1:`, line 93: the rule 4 order before rule 5 moves the cooldown leg).

`export_vectors.py --check` at the head: "same (bytes)" × 11 (ten JSON files and the `.sha256`). The check's branches,
each provoked once on `calm.json` and restored: one extra space with the same versions → "DIFFERS (bytes)"; the header
saying another Python (3.13.0) → "same (values, not bytes: written with python 3.13.0 numpy 2.5.4)"; then one price
changed → "DIFFERS (values, not bytes: …)"; one byte appended to the engine copy → the script stops on the sha256.

Vectors by family, at the head:

| family | vectors (soft / rigid) | reference: every leg / some / none | ticks | fills: select + catch-up | idle ticks by reason | unbought chunks | per-leg reasons (leg × tick) |
|---|---|---|---|---|---|---|---|
| calm | 20 (20 / 0) | 20 / 0 / 0 | 616 | 456 + 0 | calendar 96, complete 64 | 0 | complete 437, cooldown 58, not_due 897, picked 456 |
| fall | 12 (4 / 8) | 12 / 0 / 0 | 218 | 151 + 12 | complete 27, rule9 40 | 19 | complete 266, cooldown 27, not_due 90, picked 151, rule9 120 |
| no-price | 4 (3 / 1) | 4 / 0 / 0 | 71 | 57 + 2 | complete 10, no_price 4 | 0 | complete 68, cooldown 13, no_price 17, not_due 56, picked 59 |
| band | 4 (3 / 1) | 4 / 0 / 0 | 51 | 33 + 4 | band 4, complete 7, no_price 2, rule9 5 | 2 | band 14, complete 65, cooldown 2, no_price 2, not_due 25, picked 34, rule9 11 |
| min-fill | 6 (6 / 0) | 6 / 0 / 0 | 320 | 179 + 0 | calendar 112, complete 29 | 0 | complete 275, cooldown 9, not_due 497, picked 179 |
| ties | 6 (5 / 1) | 6 / 0 / 0 | 101 | 67 + 16 | complete 18, no_price 16 | 0 | complete 79, cooldown 7, no_price 48, not_due 93, picked 76 |
| mixed | 24 (12 / 12) | 16 / 8 / 0 | 368 | 242 + 23 | band 1, calendar 23, complete 75, no_price 27 | 0 | band 12, complete 392, cooldown 44, no_price 133, not_due 254, picked 261, rule9 8 |
| no-reference | 20 (19 / 1) | 0 / 8 / 12 | 302 | 238 + 0 | complete 57, rule9 7 | 4 | complete 312, cooldown 44, no_price 2, not_due 299, picked 238, rule9 11 |
| **total** | **96 (72 / 24)** | 68 / 16 / 12 | **2047** | **1423 + 57** | band 5, calendar 231, complete 287, no_price 49, rule9 52 | **25** | band 26, complete 1894, cooldown 204, no_price 202, not_due 2211, picked 1454, rule9 150 |

Against main's fixtures (the same ids; the reference is the only new input):

| family | on main | now | tick prices unchanged | first pick changed by the reference | fills changed | done changed |
|---|---|---|---|---|---|---|
| calm | 20 | 20 | 20 of 20 | 12 | 12 | none |
| fall | 9 | 12 | 9 of 9 | 4 | 4 | none |
| no-price | 4 | 4 | 4 of 4 | 3 | 3 | none |
| band | 3 | 4 | 3 of 3 | 2 | 2 | band-n9-priority-rigid |
| min-fill | 6 | 6 | 6 of 6 | 6 | 6 | none |
| ties | 6 | 6 | 6 of 6 | 0 | 0 | none |
| mixed | 24 | 24 | 24 of 24 | 17 | 17 | none |
| no-reference | 0 | 20 | 0 of 0 | 0 | 0 | none |

The 24 new vectors (every other id is on main, with the same tick prices):

| id | weights | N | mode, threshold | stable, band | reference | n | fills | unbought | first pick | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| fall-inexact-n12-leg0-rigid | 1/3 1/3 1/3 | 12 | rigid 0.25 | - | 1.25 / 94771.847623 / 1.2501 | 4 4 4 | 12 | 0 0 0 | leg 0 | leg 0 entry 1.2: 1.2 x 0.75 is 0.8999999999999999 in doubles, so a price of exactly 0.9 is NOT protected (it buys) and 0.8999999999999999 is; rigid |
| fall-below-reference-n9-leg0-rigid | 1/3 1/3 1/3 | 9 | rigid 0.25 | - | 100 / 93375.85434 / 1.252338 | 3 3 3 | 9 | 0 0 0 | leg 0 | leg 0: reference 100, then 68.6-71.4 from tick 0 on (25% under the reference at every tick, never 25% under its tick 0 price): never protected, and it takes the first chunk; rigid |
| fall-below-entry-n9-leg1-rigid | 2/5 2/5 1/5 | 9 | rigid 0.25 | - | 3107.066408 / 100 / 1.272711 | 4 3 2 | 6 | 0 3 0 | leg 2 | leg 1: reference 100, 140 at tick 0, then 100.9-104 (over the reference, 25% under its tick 0 price): protected from tick 1 on, never buys; rigid |
| band-edge-n9-stable2-b171-soft | 1/4 1/4 1/2 | 9 | soft 0.25 | leg 2, 0.0171 | 3232 / 95000 / 1 | 2 2 5 | 9 | 0 0 0 | leg 0 | stable leg 2, band 171 bps, band_add 0.003: at 0.9859 and 1.0141 the sum |p - 1| + band_add equals the band exactly, which is IN band (the engine compares with >), and the stable buys at ticks 1 and 7; 0.9858 is out; soft |
| noref-all-25-25-50-n6 | 1/4 1/4 1/2 | 6 | soft 0.25 | - | none / none / none | 2 1 3 | 6 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-25-25-50-n6; soft |
| noref-all-25-25-50-n9 | 1/4 1/4 1/2 | 9 | soft 0.25 | - | none / none / none | 2 2 5 | 9 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-25-25-50-n9; soft |
| noref-all-25-25-50-n26 | 1/4 1/4 1/2 | 26 | soft 0.25 | - | none / none / none | 7 6 13 | 26 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-25-25-50-n26; soft |
| noref-all-40-40-20-n6 | 2/5 2/5 1/5 | 6 | soft 0.25 | - | none / none / none | 3 2 1 | 6 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-40-40-20-n6; soft |
| noref-all-40-40-20-n9 | 2/5 2/5 1/5 | 9 | soft 0.25 | - | none / none / none | 4 3 2 | 9 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-40-40-20-n9; soft |
| noref-all-40-40-20-n26 | 2/5 2/5 1/5 | 26 | soft 0.25 | - | none / none / none | 11 10 5 | 26 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-40-40-20-n26; soft |
| noref-all-33-33-33-n6 | 1/3 1/3 1/3 | 6 | soft 0.25 | - | none / none / none | 2 2 2 | 6 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-33-33-33-n6; soft |
| noref-all-33-33-33-n9 | 1/3 1/3 1/3 | 9 | soft 0.25 | - | none / none / none | 3 3 3 | 9 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-33-33-33-n9; soft |
| noref-all-33-33-33-n26 | 1/3 1/3 1/3 | 26 | soft 0.25 | - | none / none / none | 9 9 8 | 26 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-33-33-33-n26; soft |
| noref-all-30-30-40-n6 | 3/10 3/10 2/5 | 6 | soft 0.25 | - | none / none / none | 2 2 2 | 6 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-30-30-40-n6; soft |
| noref-all-30-30-40-n9 | 3/10 3/10 2/5 | 9 | soft 0.25 | - | none / none / none | 3 3 3 | 9 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-30-30-40-n9; soft |
| noref-all-30-30-40-n26 | 3/10 3/10 2/5 | 26 | soft 0.25 | - | none / none / none | 8 8 10 | 26 | 0 0 0 | leg 0 | no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; the prices of calm-30-30-40-n26; soft |
| noref-leg0-n9 | 1/4 1/4 1/2 | 9 | soft 0.25 | - | none / 92590.331041 / 1.229511 | 2 2 5 | 9 | 0 0 0 | leg 0 | leg 0 has no reference, the other two do; calm, soft |
| noref-leg1-n12 | 2/5 2/5 1/5 | 12 | soft 0.25 | - | 3087.351104 / none / 1.232557 | 5 5 2 | 12 | 0 0 0 | leg 2 | leg 1 has no reference, the other two do; calm, soft |
| noref-leg2-n9 | 3/10 3/10 2/5 | 9 | soft 0.25 | - | 3294.195617 / 94538.545734 / none | 3 3 3 | 9 | 0 0 0 | leg 1 | leg 2 has no reference, the other two do; calm, soft |
| noref-leg2-others-rise-n9 | 1/3 1/3 1/3 | 9 | soft 0.25 | - | 3042.245257 / 92440.90475 / none | 3 3 3 | 9 | 0 0 0 | leg 2 | leg 2 has no reference (variation 0); legs 0 and 1 are 3.1% over theirs at tick 0: leg 2 takes the first chunk; soft |
| noref-leg0-others-fall-n9 | 1/3 1/3 1/3 | 9 | soft 0.25 | - | none / 95188.134949 / 1.27443 | 3 3 3 | 9 | 0 0 0 | leg 1 | leg 0 has no reference (variation 0); legs 1 and 2 are 2.9% under theirs at tick 0: leg 0 does not take the first chunk; soft |
| noref-leg1-late-n9 | 2/5 2/5 1/5 | 9 | soft 0.25 | - | 3310.003084 / none / 1.278129 | 4 3 2 | 9 | 0 0 0 | leg 2 | leg 1 has no reference and no price at ticks 0-1: at tick 2 its variation counts as 0 and its entry is set; soft |
| noref-legs01-n12 | 3/10 3/10 2/5 | 12 | soft 0.25 | - | none / none / 1.271393 | 4 3 5 | 12 | 0 0 0 | leg 2 | legs 0 and 1 have no reference, leg 2 does; calm, soft |
| noref-leg0-fall-n9-rigid | 2/5 2/5 1/5 | 9 | rigid 0.25 | - | none / 94681.233538 / 1.221524 | 4 3 2 | 5 | 4 0 0 | leg 1 | leg 0 has no reference and sits at 0.679-0.700 x its tick 0 price from tick 1: protected, never recovers; rigid |

calm: the reference changes the first pick in 12 of 20 (without it, leg 0 in all 20): calm-25-25-50-n12, calm-25-25-50-n26, calm-25-25-50-n86, calm-40-40-20-n9, calm-33-33-33-n9, calm-33-33-33-n12, calm-33-33-33-n26, calm-33-33-33-n86, calm-30-30-40-n9, calm-30-30-40-n12, calm-30-30-40-n26, calm-30-30-40-n86.

`expected.perLeg` holds one row per tick (13 columns, named in every run fixture's header): the engine's variation × 3,
entry × 3, protected × 3, in band, and a reason × 3. The reason is the engine's own `why_not` for a leg that is out
(complete, no_price, band, rule9); `picked` for a leg with a fill on the tick; `cooldown` for an eligible leg that got
no chunk and was first in the engine's sorted order until line 93 moved it; `not_due` for every other eligible leg.

**No reference, as before.** The new module replays main's 72 old vectors (pd0 null, 1 694 ticks) with 0 differing.
The 12 `noref-all-*` vectors are main's `calm-*` vectors of the same split and N: every old input field and every old
expected field identical.

Claims the exporter checks before writing (it stops when one fails). Every vector, every tick, every leg: the engine's
entry is the leg's first TICK price (never the reference); its variation is price ÷ previous price − 1 with the
reference as the first previous price, null when there is none; protected is price ≤ entry × (1 − threshold);
"picked" marks exactly the legs with a fill; never more than 2 chunks of a leg per tick, nothing after the last grace
tick; soft vectors complete with deviation < 1e-9 pp; rigid ones report no k_soft. calm: every leg has a reference, a
re-run without it gives leg 0 the first chunk, and the reference changes the first pick in at least one vector. fall:
a protected leg buys only in the soft window; rigid + never recovering leaves chunks; the N = 26 soft fall hits the
2-per-leg limit; the 3.0 / 3.000001 boundary, where the reference 4.4 would put both on the same side; inexact:
1.2 × 0.75 == 0.8999999999999999 < 0.9, no tick at 0.9 is protected, every tick at 0.8999999999999999 is, the leg buys
at exactly 0.9 and a re-run with one double less on that tick changes the fills; below-reference: 25% under the
reference at every tick, never protected, takes the first chunk, completes; below-entry: never 25% under the reference,
protected from tick 1 on, buys nothing. no-price: no fill without a price, holes on N − 1 and in grace, and tick 2 of
`noprice-n9-leg0-start-soft` compares against the reference. band: the stable never buys out of band; the engine's
verdict is the formula at every tick; the band-n12 and priority claims of the first goal; edge: the sum equals the band
exactly at 0.9859 and 1.0141, those ticks are in band, 0.9858 is out, the stable buys on two of them and one double
past the edge changes the fills on each. ties: a flat reference gives v = 0 at tick 0, a common move gives a 12-decimal
tie there, leg 0 first, catch-ups present. no-reference: at such a leg's first priced tick the engine's v is nan and
its entry is set there, none before; none at all → leg 0 first; others rose → leg 2 first; others fell → leg 0 not
first; a late first price; rule 9 from the tick 0 price.

## 2 Spec versus engine (engine lines of `engine_discrete.py`; the module follows the engine)

Items a to j are in `feat-basket-selection-module.evidence.md` and still hold. New with the reference
(spec = `SPEC-BASKET-DCA.md` of the architect pack, 2026-11-16, sha256 `db68d328…12ed`; the repo copy under
`docs/Prompts/` is the older text):

| # | spec | engine | pinned by |
|---|---|---|---|
| k | §4 "Reference": the row "gives `last_i` and `entry_i` their first values"; state line: `entry_i` = "the reference price; for a leg with no reference, the decision price at its first tick with a price" | `last = pd0.copy(); entry = np.full(Lg, np.nan)` (:64) and `if np.isnan(entry[i]) and usable[i]: entry[i] = PdA[t, i]` (:71): pd0 gives `last` only, `entry` is the first TICK price in both cases. **Owner 2026-11-16: follow the engine.** | `fall-below-reference`, `fall-below-entry`, `fall-boundary` (reference 4.4), the entry columns of all 2 047 ticks; mutation N1 |
| l | §4.2: "Only a leg with no previous price at all has `v_i = 0`" | same: v is nan (:72) and ranks as 0.0 (:92, :100). The module returns `variation: null` there, not 0, so the journal can tell "no previous price" from "price unchanged" | no-reference family (54 legs without a reference) |
| m | rules for the wiring: "a price exactly on the band edge may count as out of band" | `… + badd[t] > band` (:76): a sum EQUAL to the band is IN band. At 100, 200, 500 and 1 000 bps no double price makes the sum equal the band (band_add 0, 0.001, 0.0025, 0.003, 0.005; 300 doubles each side of each edge): a decimal price on the edge lands just inside or just outside (16 cases in the test: at 1%, 0.993 + 0.003 out, 1.007 + 0.003 in, 0.99 and 1.01 out). It can be equal at 74 of the 1 000 whole-bps bands with band_add 0.003 | `band-edge-n9-stable2-b171-soft` (171 bps, 0.9859 and 1.0141); mutation G3 |
| n | same list: "a price exactly on the rule 9 threshold, to the last digit, may count as not protected" | `PdA[t, i] <= entry[i] * (1 - dd)` (:73): entry 1.2 at 25% gives 0.8999999999999999, so exactly 0.9 is not protected and (rigid) the leg buys at ticks 2, 5 and 7 | `fall-inexact-n12-leg0-rigid`; mutation N4 |
| o | rules for the wiring: the module "returns each leg's variation, protected flag and reason" | the engine has four per-leg reasons (`why_not`, :78-83) and None for an eligible leg. `picked`, `cooldown` and `not_due` are this module's names for the eligible cases, derived from the engine's fills, its sorted order (:92) and rule 5 (:93); the spec does not define them | the reason columns of all 2 047 ticks; mutations N5, N6, N7 |
| p | silent | `prot` (:73) does not depend on the soft window (`override`, :75): `protected` is true for a leg that buys in the window (13 leg-ticks in 5 vectors). "Paused by protection" is reason `rule9`, not `protected` | fall-…-stays-soft, mixed-06/10/16; mutation N8 |
| q | §4 "Buy the first one now": "the tie rule gives the first chunk to leg index 0" | holds for the first ELIGIBLE leg in index order: with no reference, a leg 0 that has no price (or is the stable leg out of band) at tick 0 does not take it | property test (baskets with no reference) |

## 3 Tests

`basket-scheduler.test.mjs`: 323 tests in 18 suites (162 in 15 on main). 96 vectors × 2 (replay; per-leg values) = 192,
72 soft ends + 24 rigid ends + 1, provenance 4, reference 7, edges 3, chooseN/kSoft 4, rounding 1, legAmounts 3,
beyond the engine 5, property 1, invalid input 6.

The file alone, at the head: Node 20.20.2 → 323 pass, 0 fail, 0 cancelled; Node 22.23.5 → the same. Whole keeper suite
(`agent-verify --keeper`): node20 1563 pass / 0 fail / 0 cancelled, node22 1563 / 0 / 0 (1 402 on main, + 161).
Node 20 and 22 are the ones at `/opt/homebrew/opt/node@20` and `node@22`.

## 4 Mutation proof (scratch copy outside the repo: module + test + fixtures; Node 22.23.5)

Each mutant is ONE exact string replacement in a copy of `basket-scheduler.js`; the runner stops when a pattern does not
match exactly once. Failing leaf tests as node:test names them, shortened: **R** = `<id> replays pick for pick`;
**P** = `<id>: the per-leg values of every tick are the engine's (variation, entry, protected, in band, reason)`;
**E** = the end-of-basket test of that vector (`soft: <id> ends with done == n …` or `rigid: <id> leaves exactly …`).
**G** rows are the four the goal names, in the forms they can take, with every failing test listed; **N** rows the rest
of the new behaviour; **O** rows the fifteen mutants of the first goal, run again on this suite.

Unmutated copy: 323 pass / 0 fail.

| # | mutation | failing / passing | failing tests |
|---|---|---|---|
| G1 | ignore the reference: a variation needs a previous TICK price (a reference-only `last` counts as none) | 144 / 179 | R+P 52: calm-25-25-50-n12, calm-25-25-50-n26, calm-25-25-50-n86, calm-40-40-20-n9, calm-33-33-33-n9, calm-33-33-33-n12, calm-33-33-33-n26, calm-33-33-33-n86, calm-30-30-40-n9, calm-30-30-40-n12, calm-30-30-40-n26, calm-30-30-40-n86, fall-n9-leg1-stays-soft, fall-n9-leg1-stays-rigid, fall-n26-leg2-stays-soft, fall-n26-leg2-stays-rigid, fall-below-entry-n9-leg1-rigid, noprice-n12-leg1-soft, noprice-n9-leg0-start-soft, noprice-n12-leg2-rigid, band-n9-stable0-b500-soft, band-n9-priority-rigid, minfill-c100-m16-n12, minfill-c250-m16-n86, minfill-c30-m3-n26, minfill-c1000-m16-n86, minfill-c20-m16-n6, minfill-c1000-m3-n86, mixed-00-soft, mixed-01-rigid, mixed-02-soft, mixed-03-rigid, mixed-04-soft, mixed-05-rigid, mixed-07-rigid, mixed-08-soft, mixed-10-soft, mixed-12-soft, mixed-15-rigid, mixed-16-soft, mixed-17-rigid, mixed-18-soft, mixed-19-rigid, mixed-20-soft, mixed-21-rigid, noref-leg1-n12, noref-leg2-n9, noref-leg2-others-rise-n9, noref-leg0-others-fall-n9, noref-leg1-late-n9, noref-legs01-n12, noref-leg0-fall-n9-rigid. P 32: calm-25-25-50-n6, calm-25-25-50-n9, calm-40-40-20-n6, calm-40-40-20-n12, calm-40-40-20-n26, calm-40-40-20-n86, calm-33-33-33-n6, calm-30-30-40-n6, fall-n9-leg1-recovers-soft, fall-n9-leg1-recovers-rigid, fall-n26-leg2-recovers-soft, fall-n26-leg2-recovers-rigid, fall-boundary-n12-leg0-rigid, fall-inexact-n12-leg0-rigid, fall-below-reference-n9-leg0-rigid, noprice-n26-all-soft, band-n12-stable2-b100-soft, band-edge-n9-stable2-b171-soft, ties-flat-n12-thirds, ties-flat-n9-25-25-50, ties-common-n26-30-30-40, ties-common-n12-40-40-20, ties-common-n9-thirds, ties-common-n15-thirds, mixed-06-soft, mixed-09-rigid, mixed-11-rigid, mixed-13-rigid, mixed-14-soft, mixed-22-soft, mixed-23-rigid, noref-leg0-n9. E 2: band-n9-priority-rigid, noref-leg0-fall-n9-rigid. other 6: `a reference changes the first pick in calm vectors: without it leg 0 always buys first, with it the leg that did worst does`; `the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first`; `a leg with no reference has no variation at its first tick with a price, and that tick sets its entry`; `the reference spans ticks without a price: the leg's first variation is still against it`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided`; `a variation that is not finite throws, whether or not the leg could buy: it is never ranked and never returned` |
| G1b | ignore the reference at tick 0 only ("variation 0 at the first tick") | 135 / 188 | R+P 48: calm-25-25-50-n12, calm-25-25-50-n26, calm-25-25-50-n86, calm-40-40-20-n9, calm-33-33-33-n9, calm-33-33-33-n12, calm-33-33-33-n26, calm-33-33-33-n86, calm-30-30-40-n9, calm-30-30-40-n12, calm-30-30-40-n26, calm-30-30-40-n86, fall-n9-leg1-stays-soft, fall-n9-leg1-stays-rigid, fall-n26-leg2-stays-soft, fall-n26-leg2-stays-rigid, fall-below-entry-n9-leg1-rigid, noprice-n12-leg1-soft, noprice-n9-leg0-start-soft, noprice-n12-leg2-rigid, band-n9-stable0-b500-soft, band-n9-priority-rigid, minfill-c100-m16-n12, minfill-c250-m16-n86, minfill-c30-m3-n26, minfill-c1000-m16-n86, minfill-c20-m16-n6, minfill-c1000-m3-n86, mixed-00-soft, mixed-02-soft, mixed-03-rigid, mixed-04-soft, mixed-05-rigid, mixed-07-rigid, mixed-08-soft, mixed-10-soft, mixed-12-soft, mixed-15-rigid, mixed-18-soft, mixed-20-soft, mixed-21-rigid, noref-leg1-n12, noref-leg2-n9, noref-leg2-others-rise-n9, noref-leg0-others-fall-n9, noref-leg1-late-n9, noref-legs01-n12, noref-leg0-fall-n9-rigid. P 32: calm-25-25-50-n6, calm-25-25-50-n9, calm-40-40-20-n6, calm-40-40-20-n12, calm-40-40-20-n26, calm-40-40-20-n86, calm-33-33-33-n6, calm-30-30-40-n6, fall-n9-leg1-recovers-soft, fall-n9-leg1-recovers-rigid, fall-n26-leg2-recovers-soft, fall-n26-leg2-recovers-rigid, fall-boundary-n12-leg0-rigid, fall-inexact-n12-leg0-rigid, fall-below-reference-n9-leg0-rigid, noprice-n26-all-soft, band-n12-stable2-b100-soft, band-edge-n9-stable2-b171-soft, ties-flat-n12-thirds, ties-flat-n9-25-25-50, ties-common-n26-30-30-40, ties-common-n12-40-40-20, ties-common-n9-thirds, ties-common-n15-thirds, mixed-06-soft, mixed-09-rigid, mixed-11-rigid, mixed-13-rigid, mixed-14-soft, mixed-22-soft, mixed-23-rigid, noref-leg0-n9. E 2: band-n9-priority-rigid, noref-leg0-fall-n9-rigid. other 5: `a reference changes the first pick in calm vectors: without it leg 0 always buys first, with it the leg that did worst does`; `the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first`; `a leg with no reference has no variation at its first tick with a price, and that tick sets its entry`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided`; `a variation that is not finite throws, whether or not the leg could buy: it is never ranked and never returned` |
| G2 | stale variation: `last` is never refreshed once set (every variation stays against the reference) | 161 / 162 | R+P 63: calm-25-25-50-n12, calm-25-25-50-n26, calm-25-25-50-n86, calm-40-40-20-n12, calm-40-40-20-n26, calm-40-40-20-n86, calm-33-33-33-n9, calm-33-33-33-n12, calm-33-33-33-n26, calm-33-33-33-n86, calm-30-30-40-n6, calm-30-30-40-n9, calm-30-30-40-n12, calm-30-30-40-n26, calm-30-30-40-n86, fall-boundary-n12-leg0-rigid, fall-inexact-n12-leg0-rigid, fall-below-reference-n9-leg0-rigid, noprice-n12-leg1-soft, noprice-n9-leg0-start-soft, noprice-n26-all-soft, band-n12-stable2-b100-soft, band-n9-priority-rigid, band-edge-n9-stable2-b171-soft, minfill-c100-m16-n12, minfill-c250-m16-n86, minfill-c30-m3-n26, minfill-c1000-m16-n86, minfill-c20-m16-n6, minfill-c1000-m3-n86, ties-common-n26-30-30-40, ties-common-n12-40-40-20, ties-common-n9-thirds, ties-common-n15-thirds, mixed-01-rigid, mixed-03-rigid, mixed-04-soft, mixed-05-rigid, mixed-07-rigid, mixed-08-soft, mixed-09-rigid, mixed-10-soft, mixed-11-rigid, mixed-12-soft, mixed-13-rigid, mixed-15-rigid, mixed-16-soft, mixed-20-soft, mixed-21-rigid, mixed-22-soft, mixed-23-rigid, noref-all-40-40-20-n9, noref-all-40-40-20-n26, noref-all-33-33-33-n6, noref-all-33-33-33-n9, noref-all-33-33-33-n26, noref-all-30-30-40-n9, noref-all-30-30-40-n26, noref-leg0-n9, noref-leg1-n12, noref-leg2-others-rise-n9, noref-leg0-others-fall-n9, noref-legs01-n12. P 31: calm-25-25-50-n6, calm-25-25-50-n9, calm-40-40-20-n6, calm-40-40-20-n9, calm-33-33-33-n6, fall-n9-leg1-stays-soft, fall-n9-leg1-stays-rigid, fall-n9-leg1-recovers-soft, fall-n9-leg1-recovers-rigid, fall-n26-leg2-stays-soft, fall-n26-leg2-stays-rigid, fall-n26-leg2-recovers-soft, fall-n26-leg2-recovers-rigid, fall-below-entry-n9-leg1-rigid, noprice-n12-leg2-rigid, band-n9-stable0-b500-soft, mixed-00-soft, mixed-02-soft, mixed-06-soft, mixed-14-soft, mixed-17-rigid, mixed-18-soft, mixed-19-rigid, noref-all-25-25-50-n6, noref-all-25-25-50-n9, noref-all-25-25-50-n26, noref-all-40-40-20-n6, noref-all-30-30-40-n6, noref-leg2-n9, noref-leg1-late-n9, noref-leg0-fall-n9-rigid. other 4: `the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first`; `the no-reference "buy now" vectors are the calm vectors' prices: the same baskets, with and without a reference`; `band, 171 bps with band_add 0.003: \|0.9859 − 1\| + 0.003 and \|1.0141 − 1\| + 0.003 EQUAL the band, which is in band (and the stable buys); one double further is out`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| G2b | stale variation: measured against entry, not against the previous price | 156 / 167 | R+P 57: calm-25-25-50-n12, calm-25-25-50-n86, calm-40-40-20-n12, calm-40-40-20-n26, calm-40-40-20-n86, calm-33-33-33-n6, calm-33-33-33-n9, calm-33-33-33-n12, calm-33-33-33-n26, calm-33-33-33-n86, calm-30-30-40-n9, calm-30-30-40-n12, calm-30-30-40-n26, calm-30-30-40-n86, fall-boundary-n12-leg0-rigid, fall-below-reference-n9-leg0-rigid, noprice-n12-leg1-soft, noprice-n9-leg0-start-soft, noprice-n26-all-soft, noprice-n12-leg2-rigid, band-n12-stable2-b100-soft, band-n9-priority-rigid, band-edge-n9-stable2-b171-soft, minfill-c100-m16-n12, minfill-c250-m16-n86, minfill-c30-m3-n26, minfill-c1000-m16-n86, minfill-c1000-m3-n86, ties-common-n26-30-30-40, ties-common-n9-thirds, ties-common-n15-thirds, mixed-01-rigid, mixed-03-rigid, mixed-05-rigid, mixed-07-rigid, mixed-08-soft, mixed-11-rigid, mixed-12-soft, mixed-15-rigid, mixed-16-soft, mixed-20-soft, mixed-21-rigid, mixed-23-rigid, noref-all-40-40-20-n9, noref-all-40-40-20-n26, noref-all-33-33-33-n6, noref-all-33-33-33-n9, noref-all-33-33-33-n26, noref-all-30-30-40-n9, noref-all-30-30-40-n26, noref-leg0-n9, noref-leg1-n12, noref-leg2-n9, noref-leg2-others-rise-n9, noref-leg0-others-fall-n9, noref-leg1-late-n9, noref-legs01-n12. P 37: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n26, calm-40-40-20-n6, calm-40-40-20-n9, calm-30-30-40-n6, fall-n9-leg1-stays-soft, fall-n9-leg1-stays-rigid, fall-n9-leg1-recovers-soft, fall-n9-leg1-recovers-rigid, fall-n26-leg2-stays-soft, fall-n26-leg2-stays-rigid, fall-n26-leg2-recovers-soft, fall-n26-leg2-recovers-rigid, fall-inexact-n12-leg0-rigid, fall-below-entry-n9-leg1-rigid, band-n9-stable0-b500-soft, minfill-c20-m16-n6, ties-common-n12-40-40-20, mixed-00-soft, mixed-02-soft, mixed-04-soft, mixed-06-soft, mixed-09-rigid, mixed-10-soft, mixed-13-rigid, mixed-14-soft, mixed-17-rigid, mixed-18-soft, mixed-19-rigid, mixed-22-soft, noref-all-25-25-50-n6, noref-all-25-25-50-n9, noref-all-25-25-50-n26, noref-all-40-40-20-n6, noref-all-30-30-40-n6, noref-leg0-fall-n9-rigid. other 5: `a leg with no reference has no variation at its first tick with a price, and that tick sets its entry`; `the no-reference "buy now" vectors are the calm vectors' prices: the same baskets, with and without a reference`; `band, 171 bps with band_add 0.003: \|0.9859 − 1\| + 0.003 and \|1.0141 − 1\| + 0.003 EQUAL the band, which is in band (and the stable buys); one double further is out`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided`; `a variation that is not finite throws, whether or not the leg could buy: it is never ranked and never returned` |
| G2c | the variation returned is not the one decided with (rounded to 12 decimals) | 100 / 223 | P 94: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n12, calm-25-25-50-n26, calm-25-25-50-n86, calm-40-40-20-n6, calm-40-40-20-n9, calm-40-40-20-n12, calm-40-40-20-n26, calm-40-40-20-n86, calm-33-33-33-n6, calm-33-33-33-n9, calm-33-33-33-n12, calm-33-33-33-n26, calm-33-33-33-n86, calm-30-30-40-n6, calm-30-30-40-n9, calm-30-30-40-n12, calm-30-30-40-n26, calm-30-30-40-n86, fall-n9-leg1-stays-soft, fall-n9-leg1-stays-rigid, fall-n9-leg1-recovers-soft, fall-n9-leg1-recovers-rigid, fall-n26-leg2-stays-soft, fall-n26-leg2-stays-rigid, fall-n26-leg2-recovers-soft, fall-n26-leg2-recovers-rigid, fall-boundary-n12-leg0-rigid, fall-inexact-n12-leg0-rigid, fall-below-reference-n9-leg0-rigid, fall-below-entry-n9-leg1-rigid, noprice-n12-leg1-soft, noprice-n9-leg0-start-soft, noprice-n26-all-soft, noprice-n12-leg2-rigid, band-n12-stable2-b100-soft, band-n9-stable0-b500-soft, band-n9-priority-rigid, band-edge-n9-stable2-b171-soft, minfill-c100-m16-n12, minfill-c250-m16-n86, minfill-c30-m3-n26, minfill-c1000-m16-n86, minfill-c20-m16-n6, minfill-c1000-m3-n86, ties-common-n26-30-30-40, ties-common-n12-40-40-20, ties-common-n9-thirds, ties-common-n15-thirds, mixed-00-soft, mixed-01-rigid, mixed-02-soft, mixed-03-rigid, mixed-04-soft, mixed-05-rigid, mixed-06-soft, mixed-07-rigid, mixed-08-soft, mixed-09-rigid, mixed-10-soft, mixed-11-rigid, mixed-12-soft, mixed-13-rigid, mixed-14-soft, mixed-15-rigid, mixed-16-soft, mixed-17-rigid, mixed-18-soft, mixed-19-rigid, mixed-20-soft, mixed-21-rigid, mixed-22-soft, mixed-23-rigid, noref-all-25-25-50-n6, noref-all-25-25-50-n9, noref-all-25-25-50-n26, noref-all-40-40-20-n6, noref-all-40-40-20-n9, noref-all-40-40-20-n26, noref-all-33-33-33-n6, noref-all-33-33-33-n9, noref-all-33-33-33-n26, noref-all-30-30-40-n6, noref-all-30-30-40-n9, noref-all-30-30-40-n26, noref-leg0-n9, noref-leg1-n12, noref-leg2-n9, noref-leg2-others-rise-n9, noref-leg0-others-fall-n9, noref-leg1-late-n9, noref-legs01-n12, noref-leg0-fall-n9-rigid. other 6: `a reference changes the first pick in calm vectors: without it leg 0 always buys first, with it the leg that did worst does`; `the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first`; `a leg with no reference has no variation at its first tick with a price, and that tick sets its entry`; `the reference spans ticks without a price: the leg's first variation is still against it`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided`; `a variation that is not finite throws, whether or not the leg could buy: it is never ranked and never returned` |
| G3 | band comparison >= instead of > | 3 / 320 | R+P 1: band-edge-n9-stable2-b171-soft. other 1: `band, 171 bps with band_add 0.003: \|0.9859 − 1\| + 0.003 and \|1.0141 − 1\| + 0.003 EQUAL the band, which is in band (and the stable buys); one double further is out` |
| G4 | no Infinity check on the variation | 1 / 322 | other 1: `a variation that is not finite throws, whether or not the leg could buy: it is never ranked and never returned` |
| N1 | entry seeded from the reference (the goal's first wording, the spec's) | 98 / 225 | R+P 6: fall-boundary-n12-leg0-rigid, fall-inexact-n12-leg0-rigid, fall-below-reference-n9-leg0-rigid, … 3 more. P 76: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n12, … 73 more. E 4: fall-boundary-n12-leg0-rigid, fall-inexact-n12-leg0-rigid, fall-below-reference-n9-leg0-rigid, fall-below-entry-n9-leg1-rigid. other 6: `the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first`; `fall-below-reference: 25% under its reference at every tick, never protected, it completes; fall-below-entry: over its reference, protected from tick 1, never buys`; `a leg with no reference has no variation at its first tick with a price, and that tick sets its entry`; … 3 more |
| N2 | an entry at tick 0 is accepted | 1 / 322 | other 1: `decideTick: NaN, negative or missing prices; done > n; an entry at tick 0 or without last; a tick, mode, threshold, band or cooldown out of range` |
| N3 | last without entry refused again (the state before this branch) | 265 / 58 | R+P 84: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n12, … 81 more. E 84: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n12, … 81 more. other 13: `a reference changes the first pick in calm vectors: without it leg 0 always buys first, with it the leg that did worst does`; `the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first`; `fall-below-reference: 25% under its reference at every tick, never protected, it completes; fall-below-entry: over its reference, protected from tick 1, never buys`; … 10 more |
| N4 | rule 9 on a product rounded to 15 digits (a decimal reading: 0.9 protected at entry 1.2) | 5 / 318 | R+P 1: fall-inexact-n12-leg0-rigid. E 1: fall-inexact-n12-leg0-rigid. other 2: `rule 9, entry 1.2 at 25%: 1.2 × 0.75 is 0.8999999999999999, so exactly 0.9 is NOT protected (and buys); one double lower is`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| N5 | reason: cooldown never reported | 68 / 255 | P 66: calm-25-25-50-n6, calm-25-25-50-n12, calm-25-25-50-n26, … 63 more. other 2: `reason "cooldown": the leg that did worst, sent to the back of the line by rule 5; "not_due": eligible, and the chunk went to another leg or none was due`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| N6 | reason: cooldown for the previous first leg even when rule 5 did not move it | 92 / 231 | P 91: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n12, … 88 more. other 1: `reason "cooldown": the leg that did worst, sent to the back of the line by rule 5; "not_due": eligible, and the chunk went to another leg or none was due` |
| N7 | reason: picked only for the first chunk's leg | 23 / 300 | P 21: noprice-n26-all-soft, band-n9-priority-rigid, ties-flat-n12-thirds, … 18 more. other 2: `reason "cooldown": the leg that did worst, sent to the back of the line by rule 5; "not_due": eligible, and the chunk went to another leg or none was due`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| N8 | protected reported as false inside the soft window | 7 / 316 | P 6: fall-n9-leg1-stays-soft, fall-n26-leg2-stays-soft, mixed-06-soft, … 3 more. other 1: `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| N9 | inBand reported for every leg | 98 / 225 | P 96: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n12, … 93 more. other 2: `the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| N10 | arrays read with forEach again (a hole is skipped) | 1 / 322 | other 1: `a sparse array throws the module's own error, for prices, legs and weights: a hole is never read as "no price"` |
| N11 | legAmounts accepts a leg at zero | 1 / 322 | other 1: `a capital that would leave a leg with amount 0 throws: the smallest capital of each split works, one unit less does not` |
| O1 | cooldown: rule 5 never moves the previous first leg back | 136 / 187 | R+P 66: calm-25-25-50-n6, calm-25-25-50-n12, calm-25-25-50-n26, … 63 more. other 4: `the no-reference "buy now" vectors are the calm vectors' prices: the same baskets, with and without a reference`; `a picked chunk that did NOT execute is due again next tick (the calendar counts executed chunks)`; `reason "cooldown": the leg that did worst, sent to the back of the line by rule 5; "not_due": eligible, and the chunk went to another leg or none was due`; … 1 more |
| O2 | cooldown: next.cooldown always null | 136 / 187 | R+P 66: calm-25-25-50-n6, calm-25-25-50-n12, calm-25-25-50-n26, … 63 more. other 4: `with NO reference on any leg, leg 0 takes the first chunk for all 4 splits (the "buy the first one now" mode relies on it)`; `the no-reference "buy now" vectors are the calm vectors' prices: the same baskets, with and without a reference`; `a picked chunk that did NOT execute is due again next tick (the calendar counts executed chunks)`; … 1 more |
| O3 | k_soft window starts one tick late (t > N - k) | 10 / 313 | R+P 4: fall-n9-leg1-stays-soft, fall-n26-leg2-stays-soft, mixed-06-soft, mixed-10-soft. P 1: mixed-16-soft. other 1: `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| O4 | k_soft = floor(N / 4) | 67 / 256 | R+P 5: fall-n9-leg1-stays-soft, fall-n26-leg2-stays-soft, mixed-06-soft, … 2 more. R 55: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n26, … 52 more. other 2: `test_engine_v32 on every product N: 1 <= k_soft < N, and 2 × (k_soft + 3) >= the largest n`; `kSoft(N) = max(1, ceil(N / 4)), no cap, for N = 1..100` |
| O5 | 2-per-leg limit -> 3 | 6 / 317 | R+P 1: ties-flat-n9-25-25-50. R 3: fall-n26-leg2-stays-soft, fall-n26-leg2-recovers-soft, fall-n26-leg2-recovers-rigid. other 1: `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| O6 | band_add ignored | 7 / 316 | R+P 1: band-n12-stable2-b100-soft. P 2: band-edge-n9-stable2-b171-soft, mixed-21-rigid. other 3: `band, 171 bps with band_add 0.003: \|0.9859 − 1\| + 0.003 and \|1.0141 − 1\| + 0.003 EQUAL the band, which is in band (and the stable buys); one double further is out`; `at the four product bands a decimal price on the edge is never ON it in doubles: it lands just inside or just outside, and this table is where`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| O7 | tie-break, first chunk: least behind first | 14 / 309 | R+P 7: band-edge-n9-stable2-b171-soft, ties-flat-n12-thirds, ties-flat-n9-25-25-50, … 4 more |
| O8 | tie-break, first chunk: higher leg wins the last tie | 44 / 279 | R+P 19: ties-flat-n12-thirds, ties-flat-n9-25-25-50, ties-common-n26-30-30-40, … 16 more. P 1: band-edge-n9-stable2-b171-soft. other 5: `a reference changes the first pick in calm vectors: without it leg 0 always buys first, with it the leg that did worst does`; `with NO reference on any leg, leg 0 takes the first chunk for all 4 splits (the "buy the first one now" mode relies on it)`; `the no-reference "buy now" vectors are the calm vectors' prices: the same baskets, with and without a reference`; … 2 more |
| O9 | tie-break, catch-up: highest variation first | 14 / 309 | R+P 7: ties-common-n26-30-30-40, ties-common-n12-40-40-20, ties-common-n9-thirds, … 4 more |
| O10 | tie-break, catch-up: the last maximal leg wins | 9 / 314 | R+P 4: ties-flat-n12-thirds, ties-flat-n9-25-25-50, ties-common-n9-thirds, ties-common-n15-thirds. other 1: `a picked chunk that did NOT execute is due again next tick (the calendar counts executed chunks)` |
| O11 | raw variation in the first-chunk sort (no 12-decimal rounding) | 6 / 317 | R+P 3: ties-common-n26-30-30-40, ties-common-n12-40-40-20, ties-common-n15-thirds |
| O12 | rounding half up instead of half to even | 1 / 322 | other 1: `290 cases, 85 exact halfway points, 35 where Python's round() differs` |
| O13 | rule 9 with < instead of <= | 6 / 317 | R+P 1: fall-boundary-n12-leg0-rigid. P 1: fall-inexact-n12-leg0-rigid. other 3: `the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first`; `rule 9, entry 1.2 at 25%: 1.2 × 0.75 is 0.8999999999999999, so exactly 0.9 is NOT protected (and buys); one double lower is`; `never over 2 picks per leg per tick, never done + picks > n, never a pick for a leg with no price, out of band or blocked; the per-leg values are the ones that decided` |
| O14 | idle priority: band before no price | 1 / 322 | R 1: band-n9-priority-rigid |
| O15 | done counts the picks as executed | 284 / 39 | R+P 96: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n12, … 93 more. E 80: calm-25-25-50-n6, calm-25-25-50-n9, calm-25-25-50-n12, … 77 more. other 12: `a reference changes the first pick in calm vectors: without it leg 0 always buys first, with it the leg that did worst does`; `with NO reference on any leg, leg 0 takes the first chunk for all 4 splits (the "buy the first one now" mode relies on it)`; `the reference is `last`, never rule 9's entry: 30% under the reference at the first tick is not protected, and buys first`; … 9 more |

Replacements (exact strings; each `from` occurs exactly once in the module):

- G1: `if (!usable[i] || leg.last === null) return null` → `if (!usable[i] || leg.last === null || leg.entry === null) return null`
- G1b: `if (!usable[i] || leg.last === null) return null` → `if (!usable[i] || leg.last === null || tick === 0) return null`
- G2: `last: usable[i] ? px[i] : leg.last, entry: entry[i] }` → `last: leg.last ?? (usable[i] ? px[i] : null), entry: entry[i] }`
- G2b: `const v = px[i] / leg.last - 1` → `const v = px[i] / (leg.entry ?? leg.last) - 1`
- G2c: `variation: variation[i],` → `variation: variation[i] === null ? null : roundVariation(variation[i]),`
- G3: `Math.abs(px[s] - 1) + add > band` → `Math.abs(px[s] - 1) + add >= band`
- G4: `if (!Number.isFinite(v)) fail(RangeError, `legs[${i}]: the variation of price ${px[i]} against last ${leg.last} is not finite`)` → `(line removed)`
- N1: `(leg.entry === null && usable[i] ? px[i] : leg.entry)` → `(leg.entry === null && usable[i] ? (leg.last ?? px[i]) : leg.entry)`
- N2: `if (entry !== null && tick === 0) {` → `if (entry !== null && tick === -1) {`
- N3: `if (entry !== null && last === null) fail(` → `if ((entry === null) !== (last === null)) fail(`
- N4: `usable[i] && px[i] <= entry[i] * (1 - threshold))` → `usable[i] && px[i] <= Number((entry[i] * (1 - threshold)).toPrecision(15)))`
- N5: `(i === displaced ? LEG_REASONS.COOLDOWN : LEG_REASONS.NOT_DUE)` → `(i === -1 ? LEG_REASONS.COOLDOWN : LEG_REASONS.NOT_DUE)`
- N6: `(i === displaced ? LEG_REASONS.COOLDOWN : LEG_REASONS.NOT_DUE)` → `(i === cooldown ? LEG_REASONS.COOLDOWN : LEG_REASONS.NOT_DUE)`
- N7: `if (taken[i] > 0) return LEG_REASONS.PICKED` → `if (picks[0] === i) return LEG_REASONS.PICKED`
- N8: `protected: isProtected[i],` → `protected: isProtected[i] && !softWindow,`
- N9: `inBand: i === s && usable[i] ? !outOfBand : null,` → `inBand: usable[i] ? !outOfBand : null,`
- N10: `for (let i = 0; i < length; i += 1) out[i] = read(x[i], i)` → `x.forEach((item, i) => { out[i] = read(item, i) })`
- N11: `if (amounts[i] <= 0n) fail(` → `if (amounts[i] < 0n) fail(`
- O1: `if (cooldown !== null && order.length > 1 && order[0] === cooldown) displaced = cooldown` → `if (cooldown === -1) displaced = cooldown`
- O2: `cooldown: picks.length > 0 ? picks[0] : null,` → `cooldown: null,`
- O3: `tick >= N - kSoft(N)` → `tick > N - kSoft(N)`
- O4: `return Math.max(1, Math.ceil(cycles / 4))` → `return Math.max(1, Math.floor(cycles / 4))`
- O5: `if (taken[i] >= CHUNKS_PER_LEG_PER_TICK ||` → `if (taken[i] >= 3 ||`
- O6: `Math.abs(px[s] - 1) + add > band` → `Math.abs(px[s] - 1) > band`
- O7: `-(state[i].n - state[i].done) / state[i].n,` → `(state[i].n - state[i].done) / state[i].n,`
- O8: `compareKeys(firstKey(a), firstKey(b)) || a - b)` → `compareKeys(firstKey(a), firstKey(b)) || b - a)`
- O9: `-(variation[i] ?? 0)]` → `(variation[i] ?? 0)]`
- O10: `compareKeys(catchKey(i), catchKey(best)) > 0` → `compareKeys(catchKey(i), catchKey(best)) >= 0`
- O11: `variation[i] === null ? 0 : roundVariation(variation[i]),` → `variation[i] === null ? 0 : variation[i],`
- O12: `return (r - x === 0.5 && r % 2 !== 0 ? r - 1 : r) / 1e12` → `return r / 1e12`
- O13: `usable[i] && px[i] <= entry[i] * (1 - threshold))` → `usable[i] && px[i] < entry[i] * (1 - threshold))`
- O14: `[IDLE_REASONS.NO_PRICE, IDLE_REASONS.BAND, IDLE_REASONS.RULE9].find` → `[IDLE_REASONS.BAND, IDLE_REASONS.NO_PRICE, IDLE_REASONS.RULE9].find`
- O15: `({ n: leg.n, done: leg.done, last:` → `({ n: leg.n, done: leg.done + taken[i], last:`

## 5 Verify

`scripts/agent-verify.sh --keeper --codeql`, at the head of the code (the commit after it only adds these two files):

```
=== EVIDENCE ===
branch: feat/basket-selection-reference @ cf79894a (base origin/main @ c23cec40)
suite:       PASS 10814 tests passed, 0 failed, 502 files
lint-delta:  PASS errors +0, warnings +0 (2 changed files; head 0 err/0 warn, base 0 err/0 warn)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      PASS node20:1563-pass/0-fail/0-cancelled node22:1563-pass/0-fail/0-cancelled
diff --stat origin/main...HEAD:
 contracts/order-engine/executor/basket-scheduler.js             |  148 ++-
 contracts/order-engine/executor/basket-scheduler.test.mjs       |  474 +++++++-
 contracts/order-engine/executor/fixtures/basket-dca/band.json   |  160 ++-
 contracts/order-engine/executor/fixtures/basket-dca/calm.json   |  858 ++++++++++++--
 .../order-engine/executor/fixtures/basket-dca/choose-n.json     |    5 +-
 .../executor/fixtures/basket-dca/engine_discrete.py             |  134 +++
 .../executor/fixtures/basket-dca/engine_discrete.py.sha256      |    1 +
 contracts/order-engine/executor/fixtures/basket-dca/fall.json   |  543 ++++++++-
 .../order-engine/executor/fixtures/basket-dca/min-fill.json     |  393 ++++++-
 contracts/order-engine/executor/fixtures/basket-dca/mixed.json  |  679 +++++++++--
 .../order-engine/executor/fixtures/basket-dca/no-price.json     |  134 ++-
 .../order-engine/executor/fixtures/basket-dca/no-reference.json | 1650 +++++++++++++++++++++++++++
 .../order-engine/executor/fixtures/basket-dca/rounding.json     |    5 +-
 contracts/order-engine/executor/fixtures/basket-dca/ties.json   |  158 ++-
 docs/feedback/feat-basket-selection-reference.md                |   35 +
 scripts/basket-dca/export_vectors.py                            |  617 ++++++++--
 16 files changed, 5487 insertions(+), 507 deletions(-)
compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/basket-selection-reference
RESULT: PASS
=== END EVIDENCE ===
```

`node scripts/gen-claude-state.mjs --check`: "CLAUDE.md state block is current" (no test file added: keeper 53).
`node scripts/check-agents-parity.mjs`: "AGENTS.md parity OK". `export_vectors.py --check`: "same (bytes)" × 11.

The run before the rebase (the same three commits at `04f3bb37`, on main `0a797163`) was stopped after six checks:
suite 10 796 passed / **4 failed**, the four tests of `scripts/agent-verify.test.mjs` the goal names
("agent-verify --keeper (CI Node majors, fake installs)"), lint-delta +0/+0, tsc 0, build ok, v1v2-parity 111/0,
rpc-budget 36/0. PR #698, merged on main meanwhile, fixes those four; with it the suite is 10 814 / 0.
