# fix/keeper-active-orders-window — SEC-4 (keeper's 15-row active-orders window)

Keeper, fund-flow: Draft PR, **Auditor required**. Base origin/main `4a4129ef`. Long tables: `fix-keeper-active-orders-window.tables.md` (T1–T5).

## Round 2 — A88 audit (blocked 0C/3H at a9f12d9a), design 120b

origin/main `bfe26155` merged first (merge commit `a01d9251`). Long tables for round 2: the tables file, R1–R9.

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

- [ ] Probes of the audit as tests, each shown FAILING on a9f12d9a (flood 15/16/30, scan 503 at 0.5/2/10 %, overlap A-B-A-C,
      count/wrap throwing or hanging, gas SKIP one cycle, restart loops) + the owner's 40-unanswerable test
- [ ] Scan <= 1000 rows (keyset pages), pre-screen via Multicall3 (chunks <= 50, 5 s each), struct from the path's own builder
- [ ] Walk: ready rows oldest first through the unchanged path; expired rows; rotating 15-row budget; MAX_BATCH unchanged
- [ ] Carry-over; pre-screen failure falls back, flagged; slow-down removed (state, tests, log field)
- [ ] S-2 S-3 S-4 S-6 S-7 S-8 S-9 S-10 S-11 S-12
- [ ] Shipped-cycle tests that really execute (MAX_BATCH mid-list, gas SKIP, carry-over); mutant M6 fails
- [ ] Differential vs origin/main (500 seeded runs, M <= 15); seeded properties; pre-screen chunk failures; mutation proof
- [ ] Multicall3 code + one aggregate3 call on Base and Arbitrum (public RPC)
- [ ] Runbooks, ADR-024 / ADR-026 dated notes
- [ ] Keeper suite Node 20 + 22; agent-verify --keeper --codeql (load < 10, once); gen-claude-state --check; push; evidence 1-6

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
