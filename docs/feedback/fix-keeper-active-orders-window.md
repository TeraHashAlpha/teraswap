# fix/keeper-active-orders-window — SEC-4 (keeper's 15-row active-orders window)

Keeper, fund-flow: Draft PR, **Auditor required**. Base origin/main `4a4129ef`. Long tables: `fix-keeper-active-orders-window.tables.md` (T1–T5, R1–R10).

## Round 2 — A88 audit (blocked 0C/3H at a9f12d9a), design 120b

Main merged `a01d9251` (bfe26155) and `5d45dfe2` (7bd3ec12). Tables R1–R10 in the tables file. Checklist (`978989a6`): all 10 items done.

**Owner answers (asked once, 2026-11-18; they supersede the goal text).** 1. Carry-over keeps oldest-first order (re-read by
id, and first, only when the rotating scan does not hold the row). 2. Multicall3 check: read-only public RPC allowed. 3. Expired
rows always walked; ONE 15-row budget for rows the pre-screen cannot answer, rotating (least recently walked first); 5 s limits;
added test: 40 unanswerable rows, one more walked within 3 cycles. 4. Register only walked DCA rows (main's quorum-wiring regex).

**Evidence.** (tests: P `active-scan-probes`, C `active-scan-cycle`, U `active-window`, Pr `active-scan-property`)
1. Every finding fixed. S-1 asking without locking, 1000-row scan `executor.js:351,940`, only true rows walked `:1836` (P flood ×4,
   Pr). S-2 failed scan read = main's 15 oldest, nothing moves `:801-818,992` (P 503 ×4). S-3 one tick at a time `:2643,3045`, prune
   after two complete scans `active-window.js:243` (P overlap, C ×3). S-4 5 s on every read `:751`, count/wrap caught `:844,849` (P ×4).
   S-5 carry-over incl. the SKIP row `:2336,2580`, re-read by id `:857` (P gas ×2, C). S-6 fills through a fake wallet (C ×3); M6
   killed. S-7 alert warn then hourly, /health counters `:1013,2702` (C). S-8 random first page `:819` (P ×2). S-9 no count header
   on the fallback `:806` (cycle test). S-10 dated notes ADR-024/026, runbook § 9. S-11 `Active scan:` line, validated numbers,
   bodies <= 200 chars, ids/URLs masked `active-window.js:333-366` (U, C). S-12 slow-down removed; comments, both runbooks.
2. Bound: every active row asked within ceil(M/1000) cycles + 1 per fallback cycle. Hiding one needs 1000 new rows/cycle
   (2000/min): >= 200 IPs at 10/min and 6000 wallets/h at 20/wallet/h; one IP adds 5 rows/cycle (R2).
3. Calls per cycle, nothing ready, RPC / Supabase main → branch: M=0 0→0 / 2→2; M=1 2→1 / 4→2; M=15 30→1 / 32→2; M=100 30→2 /
   32→2; M=1000 30→20 / 32→2 (M=1500: 30→20 / 32→3). Each fill costs the same in both (R3).
4. Differential: 500 runs (seeds 53759 + i·7919), 6000 cycles, 5096 fills, 0 differences (R4). Properties: 20 shipped seeds × 80
   cycles, no double fill, <= 5/cycle, bound held, pre-screen wrote nothing; 30 pure seeds, no active row's streak pruned (R5).
   Mutants: the goal's five + M6 + rotation killed; carried-literally-first caught by the differential (R6).
5. Host log, one per cycle: `Active scan: active=<n> scanned=<n> true=<n> attempted=<n> carried=<n> rotate=no fallback=none`;
   absent `Active scan query FAILED (`, `Pre-screen chunk`, `fallback=scan-`, `fallback=prescreen-`; not repeating `Supabase fetch
   error (scan wrap):`, `Tick skipped:`; gone `Active window:`, `Querying:`, `Supabase returned`, `First order:` (runbook § 9).
6. agent-verify --keeper --codeql, once, quiet (load 5–7): PASS on `c4c9a878` (suite 11090, CodeQL 13=13, keeper 2136 Node 20+22).
   After it, `df38ad6b` restored the probe file (below): keeper 2137/2137 on Node 20 and 22, agent-verify NOT re-run (rule: once).
   gen-claude-state current; gitleaks clean. Diff since a9f12d9a (this round's files): 16 files, +2541/−1006 at c4c9a878.
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-active-orders-window. NOT verified: the reads
   against a real Supabase (offset, id=in, count, max_rows), a real canExecute through Multicall3, the host, CI.

**Changed test expectations (CAPITALS; all other existing tests unchanged).**
- COMMIT `cc262b34` SAID "NO ASSERTION CHANGED": WRONG. IT LOWERED THE FULL-SIZE FLOOD FLOOR `checked > 5000` TO `> 3000` (13 → 8
  CYCLES), DELETED THE FULL-SIZE 10 % S-2 PROBE AND SHRANK THE SCALED S-2 AND S-8 PROBES. `df38ad6b` RESTORES THE FILE BYTE FOR BYTE.
- REMOVED WITH THE SLOW-DOWN: 5 tests in `active-window.test.mjs`, 2 in `active-window-cycle.test.mjs`.
- REMOVED WITH ROUND 1'S CURSOR-BY-REACHED-ROWS, KEEP-SET AND LOG LINE: `advanceActiveWindow` (5), `activeWindowKeepIds` (3), round
  1's properties (4 + the shipped one, now `active-scan-property`), the `Active window:` line test.
- ROUND 1 SELECTION TESTS MOVED TO `advanceScan`, SAME EXPECTATIONS; "CANNOT KNOW THE END" NOW READS WITHOUT A COUNT.
- `active-window-cycle.test.mjs`: STEP 0 "<= 15 ASKS" → "<= SCAN_CAP + 15, PATH ASKS ONLY THE READY ROW"; `Active scan:` REGEXES;
  WHOLE CHAIN EVERY CYCLE; RESTART AND IDLE-PROBE TESTS (SCAN 15) START AT A RANDOM PAGE (S-8); 400 FALLBACK MATCHES THE SCAN READ,
  FLAG `fallback=scan-400`, + NO COUNT HEADER; PAUSED-BRANCH AND CONSTANT ANCHORS RENAMED.
- MAIN'S `price-quorum-wiring.test.mjs`: REGISTERTOKENS REGEX AND NAME → WALKED DCA ROWS ONLY (owner answer 4).

Round-2 feedback (assumptions that were wrong, concerns): tables R10.

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
