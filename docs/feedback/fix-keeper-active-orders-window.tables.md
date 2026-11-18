# fix/keeper-active-orders-window — long tables (companion of `fix-keeper-active-orders-window.md`)

## T1. Step 0 on origin/main code (`4a4129ef` executor.js, test commit `ecd422e9`)

`node --test contracts/order-engine/executor/active-window-cycle.test.mjs`, Node v20.20.2 and v22.23.5, both exit 1:

```
not ok 1 - 15 old rows whose canExecute is false + 1 newer executable row: the newer row is examined within 20 cycles
  location: '…/contracts/order-engine/executor/active-window-cycle.test.mjs:46:3'
  error: 'the newer executable row was never examined in 20 cycles; per-cycle canExecute calls: 15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15'
# tests 1  # pass 0  # fail 1  # cancelled 0
```

The 15 old rows: 5 `Insufficient balance`, 5 `Insufficient allowance`, 5 DCA `DCA interval not reached`. The shipped
`executeCycle` + `fetchActiveOrders` ran against an in-process fake PostgREST (`executor-cycle.fixture.mjs`); "examined" =
`canExecute` asked. Same test after the fix: pass (newer row examined in cycle 2).

## T2. New tests (both Nodes, same counts)

| File | Tests | What |
|---|---|---|
| `active-window.test.mjs` | 31 | query params (exact strings, `+` ⇒ `%2B`, quoting), `cursorOf` refusals, edges (empty, 1, 15, 16 rows, 40 equal `created_at`, other chain, dedupe), cursor advance, keep-set, slow-down, log line, seeded property |
| `active-window-cycle.test.mjs` | 16 | Step 0; shipped cycle: empty / 1 / 15 rows, equal `created_at`, restart mid-rotation, idle probe never moves the cursor, chain scope, slow-down timing (fake clock), log line, keyset 400 fallback, both reads failing, seeded property, 2 source anchors |

Seeded property, pure helper (`active-window.test.mjs`): seeds `0x5ec4 + i·7919`, i = 0..39; 140 cycles each; initial
table 1–400 rows (largest seen 396); 0–3 rows added (70 % newest, 15 % tied `created_at`, 15 % back-dated) and 0–3
removed per cycle, filled limit orders leave; canExecute answers from 7 personas; executions stop the loop at
MAX_BATCH; a gas SKIP stops it with p = 0.03; restarts with p = 0.01. Totals: 5,600 cycles, 613,857 (row, start-cycle)
bound checks, 2,591 slowed re-examinations, 136 early stops, 51 restarts. Checks: window and examined ≤ 15 every cycle;
every row present for ceil(M/15) + 1 + E consecutive cycles is reached (M = distinct rows present in those cycles,
E = early stops in them; windows that span a restart are measured from the restart); a skipped-as-slowed row had 3
balance/allowance answers in a row since the last restart and its last one < 10 min ago; once slowed, its next answer
comes ≥ 10 min later; a slowed row present for 10 min + one rotation is examined again; no in-memory entry of an
active row is ever pruned; a removed row's entry is pruned within two rotations (> 100 removals checked); a page
carrying another chain's row never hands it to the loop (10 seeds). Static tables M ∈ {1, 2, 14, 15, 16, 29, 30,
31, 100, 399, 400}: every row within exactly ceil(M/15) cycles from every starting cursor.

Seeded property, shipped cycle (`active-window-cycle.test.mjs`): seeds `0x51c4 0x2b07 0x9e3d 0x0f11 0x7a5a 0x3c90`,
initial M0 = 389 / 141 / 369 / 26 / 119 / 325, 25 rows of chain 42161 in the same table, 0–2 added (15 % tied) and
0–2 removed per cycle, fake clock 30 s/cycle: 33,415 bound checks on never-slowed rows (K = ceil(M/15) + 1) and
18,096 on slowable rows (20 cycles = 10 min + K). No canExecute outside chain 8453; ≤ 15 per cycle.

## T3. Mutation proof (scratch copies of the executor directory; `node --test active-window.test.mjs active-window-cycle.test.mjs`, Node 22; run at `a94a963a` and again at `39818055` — identical counts and messages)

| Mutant | Edit | Result | Failing tests (leaf names) |
|---|---|---|---|
| cursor never advances | `active-window.js` `advanceActiveWindow`: `const cursor = scan.cursor` | 47 tests, **20 fail** | Step 0 (`per-cycle canExecute calls: 15,15,15,5,5,…` — the slow-down alone does not fix SEC-4); 16 rows ⇒ the 16th in the second window; static tables meet ceil(M/15); random-tables property; shipped-cycle property; restart mid-rotation; idle probe; exactly 15 rows (both levels); equal `created_at` (both levels); MAX_BATCH stop ⇒ cursor on the 7th; cursor stops ON the newest row; wrap flag; loop reached every row; empty table; pruning property; keyset 400 fallback; both reads failing; one window line per cycle |
| slow-down on "interval not reached" | `ACTIVE_WINDOW_SLOW_REASONS` + `"DCA interval not reached"` | 47 tests, **6 fail** | the slow reasons are exactly the contracts' two strings; any other answer clears the streak; unfunded/allowance-less asked 3×, then once per 10 min, interval/price every pass; funded-again row; exactly 15 rows (shipped); shipped-cycle property (`interval row present in cycles 20..30 never examined`) |
| window doubled | `executor.js`: `const windowSize = MAX_BATCH * 6` | 47 tests, **8 fail** | Step 0 (`cycle 1 examined 16 rows (> 15)`); exactly 15 rows (`cycle 1 read a full page`); one window line per cycle; restart mid-rotation; idle probe; keyset 400 fallback; both reads failing; shipped-cycle property; the window size is today's (anchor) |

## T4. Log lines (shipped cycle against the fake; 37 active rows, 5 unfunded; `[hh:mm:ss]` masks the clock)

```
[hh:mm:ss]   Found 15 active order(s)
[hh:mm:ss]   Active window: active=37 window=15 examined=15 slowed=0 wrap=no
[hh:mm:ss]   Cycle done: 0 executed, 15 skipped
…
[hh:mm:ss]   Active window: active=37 window=15 examined=15 slowed=0 wrap=yes        ← every ceil(37/15) = 3 cycles
…
  Active window query REJECTED (400: {"code":"PGRST100","message":"failed to parse logic tree"}) — using the 15 oldest rows instead for every cycle it fails (logged once per process)
[hh:mm:ss]   Active window: active=37 window=15 examined=10 slowed=5 wrap=no keyset=rejected(400) fallback=oldest
…
[hh:mm:ss]   No active orders
[hh:mm:ss]   Active window: active=0 window=0 examined=0 slowed=0 wrap=yes
```

Gone: `Querying: <SUPABASE_URL>/rest/v1/orders?…`, `Supabase returned N row(s)`, `First order: id=…, status=…, wallet=0x…`.
A paused cycle (ADR-026 §3) prints its window line with `examined=0 … wrap=no`. Supabase reads per cycle: 1 GET when
the cursor is at the start (every idle probe: the cursor resets when the chain has no active row), otherwise 2
(window page + either the wrap page or one `HEAD … count=exact`); 3 only on a keyset rejection. Before: 1 GET.

## T5. Every full-suite run of this goal, in order (none rerun to turn it green; load = 1/5/15-min averages, 10-core Mac shared with other sessions)

| # | Code | Check | Node | Result | Failing test |
|---|---|---|---|---|---|
| 1 | branch `a94a963a` | keeper `node --test` | v22.23.5 | 1610/1610 | — |
| 2 | branch `a94a963a` | keeper `node --test` | v20.20.2 | 1609/1610 | `chain-verify.test.mjs:765` 37.3× (0.85 → 31.5 ms) > RATIO_BOUND 30 |
| 3 | branch `a94a963a` | agent-verify keeper (load ≈ 56–60) | v20 / v22 | 1609/1610 each | same test: 101.0× (0.70 → 70.4 ms) / 48.1× (0.62 → 29.9 ms) |
| 4 | branch `a94a963a` | agent-verify suite (vitest) | 22 | 10843 pass / 2 fail | 5 s timeouts: `useQuote.log-quote.callers.test.ts:163`, `scripts/agent-hooks.test.mjs:110` |
| 5 | main `4a4129ef` | keeper `node --test` (load 38.7) | v20 / v22 | 1563/1563 each | — |
| 6 | main `4a4129ef` | vitest, agent-verify's command (load 36 → 100) | 22 | 10811 pass / 34 fail, 10 files | timeouts incl. `useQuote.log-quote.callers` ×2 and `agent-hooks` ×19 |
| 7 | branch `39818055` (fix attempt 1) | keeper `node --test` (load 24.8) | v20 / v22 | 1610/1610 each | — |
| 8 | branch `39818055` | agent-verify keeper (23:33–00:11Z, 38 min) | v20 / v22 | **1610/1610 each** | — |
| 9 | branch `39818055` | agent-verify suite (vitest; load ≈ 30–65) | 22 | 10834 pass / 11 fail | all 5 s timeouts: `agent-hooks` ×9, `retired-claims.test.ts:104`, `useQuote.log-quote.callers.test.ts:163` |

agent-verify `39818055` otherwise: lint-delta +0/+0, tsc 0, `next build` ok, v1v2-parity 123/123, rpc-budget 36/36, CodeQL
security-extended head 13 = base 13, 0 new by rule+file+message.

Reading: rows 4, 6 and 9 — vitest red only on 5 s timeouts in files this branch does not touch (the diff has no file
vitest collects), and untouched main is red on the same files under the same load. Rows 2, 3 vs 5 — the timing test sits in
an untouched file, but this branch failed it 3 of 4 times while main passed 2 of 2 at the same hour: the two new
property files burned 8.9 s of CPU (6.51 s + 2.39 s user) beside it. Fix attempt 1 (`39818055`): parse each fake
timestamp once and index the bound checks; same seeds, same assertions, same check counts (613,857 and 33,415 +
18,096), the set-based definition still asserted on a sample — 3.47 s (1.73 s + 1.74 s user). 1563 existing tests + 47
new = 1610; no existing test file is modified (`git diff --name-status origin/main`).
