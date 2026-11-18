# fix/keeper-active-orders-window — SEC-4 (keeper's 15-row active-orders window)

Keeper, fund-flow: Draft PR, **Auditor required**. Base origin/main `4a4129ef`. Long tables: `fix-keeper-active-orders-window.tables.md` (T1–T5).

## Round 2 — A88 audit (blocked 0C/3H at a9f12d9a), design 120b

origin/main `bfe26155` merged first (`a01d9251`), `7bd3ec12` before the verify (`5d45dfe2`). Long tables: the tables file, R1–R9.

### Owner answers (asked once, 2026-11-18; they supersede the goal text)

1. Carry-over order: **oldest first**. A carried row is always attempted next cycle; when the rotating scan (M > 1000) did not
   return it, it is re-read by id and goes first; when the scan holds it (always with M <= 1000) it keeps its oldest-first place,
   so with M <= 15 the executed order is main's and the differential holds as written.
2. Multicall3: **read-only public RPC** allowed: one `eth_getCode` and one `aggregate3` `eth_call` per chain on the chains' public
   keyless endpoints; nothing from the project is sent.
3. Path entry: off-chain-expired rows always enter the per-order path; every row the pre-screen could not answer shares ONE budget
   of 15 per cycle, and the budget **rotates**: rows that used it go to the back of that queue next cycle. Time limits 5 s per
   Supabase read and per Multicall3 chunk. Added test: 40 permanently unanswerable rows and one that becomes answerable: it is
   walked within 3 cycles.
4. `price-quorum-wiring.test.mjs` (main): register only the DCA rows the path walks; that one anchored line and its regex change.

### Checklist

- [x] Probes of the audit as tests, each shown FAILING on a9f12d9a (flood 15/16/30, scan 503 at 0.5/2/10 %, overlap A-B-A-C,
      count/wrap throwing or hanging, gas SKIP one cycle, restart loops) + the owner's 40-unanswerable test
- [x] Scan <= 1000 rows (keyset pages), pre-screen via Multicall3 (chunks <= 50, 5 s each), struct from the path's own builder
- [x] Walk: ready rows oldest first through the unchanged path; expired rows; rotating 15-row budget; MAX_BATCH unchanged
- [x] Carry-over; pre-screen failure falls back, flagged; slow-down removed (state, tests, log field)
- [x] S-2 S-3 S-4 S-6 S-7 S-8 S-9 S-10 S-11 S-12
- [x] Shipped-cycle tests that really execute (MAX_BATCH mid-list, gas SKIP, carry-over); mutant M6 fails
- [x] Differential vs origin/main (500 seeded runs, M <= 15); seeded properties; pre-screen chunk failures; mutation proof
- [x] Multicall3 code + one aggregate3 call on Base and Arbitrum (public RPC)
- [x] Runbooks, ADR-024 / ADR-026 dated notes
- [x] Keeper suite Node 20 + 22; agent-verify --keeper --codeql (load < 10, once); gen-claude-state --check; push; evidence 1-6

### Evidence (round 2)

1. **Findings** (lines at the head below; tests in `active-scan-probes` P, `active-scan-cycle` C, `active-window` U, `-property` Pr):
   S-1 fixed: ask without locking, scan `SCAN_CAP` 1000 `executor.js:351,940`, walk only true rows `:1836` — P flood ×4, Pr.
   S-2 fixed: a failed scan read = main's 15 oldest, nothing moves `executor.js:801-818`, `:991-992` — P 503 ×3, Pr.
   S-3 fixed: one tick at a time `executor.js:2643,3045`; prune only after two complete scans `active-window.js:243` — P overlap, C ×3.
   S-4 fixed: 5 s on every Supabase read `executor.js:751`; count/wrap caught `:844,849` — P count/wrap ×4.
   S-5 fixed: carry-over incl. the SKIP row `executor.js:2336,2580`, re-read by id `:857` — P gas ×2, C gas SKIP.
   S-6 fixed: shipped cycles with a fake wallet that fills — C MAX_BATCH, gas SKIP, carry-over leads; M6 killed (R6).
   S-7 fixed: alert warn then hourly + /health counters `executor.js:1013,2702` — C alert pacing, /health.
   S-8 fixed: random first page when M > 1000 `executor.js:819` — P restart ×2. S-9 fixed: no count header on the fallback
   `executor.js:806` — cycle "400 ⇒ today's query" (prefer = ""). S-10 fixed: <= 1000 ⇒ streaks count cycles; dated notes
   ADR-024, ADR-026, runbook § 9. S-11 fixed: `Active scan:` line, validated numbers, bodies <= 200 chars, ids/URLs masked
   `active-window.js:333-366` — U line, C detail line. S-12 fixed: slow-down removed; comments, both runbooks (§ 9, S2.5).
2. **Bound**: every active row asked within ceil(M/1000) cycles + 1 per fallback cycle. Hiding a row takes 1000 new rows per
   cycle = 2000/min; the create limits (10/min per IP, 20 per wallet per hour, no funds check) need >= 200 IPs and 6000
   wallets/h for that. One IP: 5 rows/cycle (0.5 % of a scan) (R2).
3. **Calls per cycle, none ready, main → branch** (R3): M=0 RPC 0→0, Supabase 2→2; M=1 2→1, 4→2; M=15 30→1, 32→2;
   M=100 30→2, 32→2; M=1000 30→20, 32→2; M=1500 30→20, 32→3. Each fill costs the same in both.
4. **Differential** 500 runs (seeds 53759 + i·7919), 6000 cycles, 5096 fills: 0 differences (R4). **Properties**: shipped,
   20 seeds × 80 cycles: no double fill, <= 5/cycle, bound held (22,528 checks), pre-screen wrote nothing (8,674 writes);
   pure: 30 seeds, no active row's entry pruned (R5). **Mutants** M1–M7 killed, M8 (carried first) by the differential (R6).
5. **Host log** (each app, `pm2 logs <app> --lines 200 --nostream`): one per cycle
   `Active scan: active=<n> scanned=<n> true=<n> attempted=<n> carried=<n> rotate=no fallback=none` (`scanned` = `active`
   while <= 1000); absent: `Active scan query FAILED (`, `Pre-screen chunk`, `fallback=scan-`, `fallback=prescreen-`;
   not repeating: `Supabase fetch error (scan wrap):`, `Tick skipped:`, `Cycle error:`; gone: `Active window:`,
   `Querying:`, `Supabase returned`, `First order:`; `/health` stats `scanFallbackCycles`, `prescreenFallbackCycles`,
   `overlapSkippedTicks` = 0.
6. **Verify** (once, quiet: load1 7.04 / 5.31 at the two checks 15:36Z, no other verify or CodeQL): `agent-verify --keeper
   --codeql` on `c4c9a878` **RESULT: PASS** — suite 11090/11090, lint +0/+0, tsc 0, build ok, parity 123, rpc-budget 36,
   CodeQL 13 = 13 / 0 new, keeper 2136/2136 on Node 20 and 22 (R9). `gen-claude-state --check`: current. gitleaks: no leaks. diff since a9f12d9a, this round's files:
   16 files, +2541 / −1006 (`executor.js` +568 lines touched, `active-window.js` rewritten, tests/fixture/rig ~2,000, docs
   136). Verified head `c4c9a878`; HEAD adds only this paragraph and R9 (docs). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-active-orders-window
   **Not verified**: PostgREST accepting `offset=` with `or=` absent, `id=in.(…)` and the count against a real Supabase
   (fake only); Supabase `max_rows` below 1000 (the count decides the end: a unit test, not a real server); Multicall3
   beyond code presence and one `getChainId` call (no real `canExecute` through it); a run on the host; CI.

### Changed test expectations (CAPITALS; every other existing test unchanged)

- REMOVED WITH THE SLOW-DOWN: `active-window.test.mjs` "slow-down — only balance/allowance…" (4 tests) and "pruneSlowRows…";
  `active-window-cycle.test.mjs` "shipped cycle — slow-down" (2 tests).
- REMOVED WITH ROUND 1'S CURSOR-BY-REACHED-ROWS AND ROTATION KEEP-SET (replaced by carry-over / two complete scans):
  `active-window.test.mjs` "advanceActiveWindow…" (5), "activeWindowKeepIds…" (3), round 1's property describe (4);
  `active-window-cycle.test.mjs` round 1's seeded property (now `active-scan-property.test.mjs`); `active-window.test.mjs`
  "the log line carries counts only" (round 1's `Active window:` format) → THE `Active scan:` LINE TESTS.
- ROUND 1 SELECTION TESTS MOVED FROM advanceActiveWindow TO advanceScan, SAME EXPECTATIONS; "exactly 15 rows": THE
  "CANNOT KNOW THE END" CHECK NOW READS WITHOUT A COUNT (the scan sends one); "empty table": COMPLETE SCAN = EMPTY SET.
- `active-window-cycle.test.mjs`: STEP 0 "<= 15 ASKS PER CYCLE" → "<= SCAN_CAP + 15, THE PATH ASKS ONLY THE READY ROW";
  EVERY `Active window:` REGEX → THE `Active scan:` LINE; "exactly 15 rows" / "one line per cycle": WHOLE CHAIN EVERY CYCLE;
  "restart mid-rotation" (SCAN 15): A RESTART STARTS AT A RANDOM PAGE, NOT THE OLDEST (S-8); idle probe (SCAN 15): THE PAGE
  AFTER THE FIRST RANDOM PAGE; 400 fallback: MATCHES THE SCAN READ (NO `or=` BELOW 1000 ROWS), FLAG `fallback=scan-400`,
  LINE "Active scan query FAILED", + S-9 NO COUNT HEADER; "both fail" (SCAN 15): CURSOR AFTER THE FIRST RANDOM PAGE;
  wiring: `advanceActiveScan(` / `prescreenRows(` ABSENT FROM THE PAUSED BRANCH; CONSTANTS `SCAN_CAP 1000`, `ONE_BY_ONE`.
- MAIN'S `price-quorum-wiring.test.mjs`: registerTokens REGEX AND NAME → ONLY WALKED DCA ROWS (owner answer 4).

### Feedback — round 2 (`2ee76254`…HEAD)

#### Assumption that turned out wrong
- A failing wrap read left the cursor on the newest row; the next cycle read an empty page and said `No active orders`
  (idle cadence) with rows on the chain. Found by the S-4 probe; fixed before commit (R1).
- The fixture faked `Date.now()` only: lock stamps (`new Date()`) and the stale-unlock cutoff ran on two clocks, so the S-3
  probe could not hold a lock across ticks. `withFakes` now fakes both.

#### Concern
- The pre-screen asks at the start of a cycle: if one fill makes ANOTHER row ready in the same cycle, that row fills a cycle
  later than on main (not modelled in the differential).
- Ready rows that a gate defers (quorum skip, no route, deviation) are walked every cycle without a per-cycle cap beyond
  MAX_BATCH fills (design: only MAX_BATCH / gas SKIP stop the loop); many of them lengthen a cycle. One tick at a time
  absorbs it; `overlapSkippedTicks` shows it.
- The new-DCA Telegram announcement now fires when a DCA order first answers true (enters the path), not when first locked.
- Rows that answer false are no longer locked/unlocked, so their `updated_at` no longer moves each cycle (nothing reads it:
  grep of `src/lib`, `src/app/api`, `workers`).
- Chunks run one after another: if all 20 time out, the cycle spends 100 s in the pre-screen (then 15 rows one by one).
- origin/main moved during the round (PR #715, keeper unchanged): merged again before the verify (`5d45dfe2`).

## Owner answers (asked once, 2026-11-17; they supersede the goal text)

One AskUserQuestion, four parts; only (1) came back answered. Per "ask ONCE", (2)–(4) were not re-asked: the recommended option was built.
1. Keyset query rejected (non-2xx) ⇒ today's exact query (15 oldest) for that cycle, logged once, flagged on the line. (answered)
2. MAX_BATCH / gas-SKIP stop ⇒ the cursor moves only past rows the loop reached; bound = ceil(M/15) + early-stop cycles. (unanswered)
3. M under churn ⇒ distinct rows active at any point in the observed cycles. (unanswered)
4. fetchActiveOrders' 3 per-query lines (Supabase URL, count, `wallet=0x…` prefix) ⇒ replaced by the one window line. (unanswered)

## Evidence

1. **Step 0** (`ecd422e9`, origin/main executor.js, Node 20 + 22, exit 1): `the newer executable row was never examined in 20 cycles; per-cycle canExecute calls: 15,15,…,15` (T1). Passes after the fix.
2. **Bound**: with M rows, every row is examined within ceil(M/15) cycles, + 1 per cycle that MAX_BATCH or a gas SKIP stops early.
   The window is up to 15 rows after an in-memory keyset cursor `active-window.js:81` (`order=created_at.asc,id.asc`), wrapping to the oldest
   when the tail is short `:126,141` / `executor.js:715-741`; the loop counts what it reached `executor.js:1543` and the cursor moves exactly
   past that `active-window.js:194`, `executor.js:2316`, so consecutive windows tile the table; an early stop (`executor.js:1542`, `:2074`)
   still moves ≥ 1 row. The cursor passes slowed rows with no lock or RPC (`executor.js:1568`, `active-window.js:233-241`). Prune keeps every
   active row's ADR-026 streak: the rotation set covers [oldest, cursor] `active-window.js:199`, keep-set `:217-219`, `executor.js:1502`.
3. **Tests**: 47 new (31 helper, 16 shipped cycle); seeded properties 40 + 6 seeds, 613,857 + 51,511 bound checks (T2). Keeper suite at
   `39818055`: Node 20 1610/1610, Node 22 1610/1610 (own run and agent-verify). Mutants killed: cursor frozen 20 fail, slow-down on
   interval 6 fail, window doubled 8 fail (T3). Earlier runs at `a94a963a` failed `chain-verify.test.mjs:765` (timing ratio) 3 of 4 times
   while main passed it 2/2: my property tests burned 8.9 s CPU beside it; fix attempt 1 (`39818055`) = same checks at 3.5 s (T5).
4. **Host log** (one line per cycle, counts only): `Active window: active=37 window=15 examined=12 slowed=3 wrap=no`; `wrap=yes` once per
   rotation; `keyset=rejected(400) fallback=oldest` + one `Active window query REJECTED …` line per process if Supabase refuses the filter;
   `active=0 window=0 … wrap=yes` after `No active orders`. Gone: `Querying:`, `Supabase returned`, `First order: … wallet=` (T4).
5. **Verify** — owner answer 2026-11-18 (second question, after `39818055` was red only on 11 vitest 5 s timeouts in untouched files
   that main also timed out on under load, T5 rows 6, 9): "run agent-verify once on this head when no other verify/CodeQL runs and the
   1-minute load is under 10; push only if green". Run on `25285c9c`, 02:16:20–02:23:18Z, load 1.62: **RESULT: PASS** — suite
   10845/10845, keeper 1610/1610 on Node 20 and 22, CodeQL 13 = 13 / 0 new, lint-delta +0/+0, tsc 0, build ok, parity 123, rpc-budget 36.
   `gen-claude-state --check`: current. gitleaks: no leaks. diff: 7 files, +2,021 / −13 (`executor.js` +119/−13; `active-window.js` 271;
   tests + fixture 1,488; docs 143). Verified head `25285c9c`; HEAD adds only this paragraph (docs).
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-active-orders-window
   **Not verified**: the keyset `or=(…)` and `HEAD`+`count=exact` against a real PostgREST/Supabase (fake only; the fallback bounds the
   damage); a run on the host; rows held `executing` by another process while the scan passes (pruned, as today); the branch merged
   with origin/main `02487c98` (#707 adds `basket-coordinator.*` beside executor.js; `git merge-tree` is clean, the combined tree untested).

## Feedback — P1 (a94a963a, 39818055)

### Assumption that turned out wrong
- My first keep-set restarted on every wrap. When the loop stopped ON the newest row the next window wrapped at once and the union
  covered only the table's two ends: the seeded property (seed 48017) caught 192 entries of ACTIVE rows dropped in one cycle. Fixed
  before commit by the [oldest, cursor] invariant; the property asserts no active row's entry is ever dropped.

### Concern
- canExecute's permanent answers (`Order cancelled`, `DCA complete`, `Nonce used`, `Invalid signature`) are unlocked to `active` and
  never slowed (goal: only balance/allowance). They no longer hide other rows, but cost a lock + RPC + unlock every pass.
- Supabase reads: 1 GET per cycle before; now 2 when the cursor is mid-table (page + wrap page or a count `HEAD`), still 1 on idle probes.
- `chain-verify.test.mjs:765` measures a ratio over a 0.7 ms baseline: any CPU-heavy file beside it can fail it.
