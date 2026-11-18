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

| 10 | branch `25285c9c` | agent-verify `--keeper --codeql`, ONE run (owner answer), started 02:16:20Z at load 1.62 with no other verify/CodeQL running | 20 / 22 | **RESULT: PASS** — suite 10845/10845, keeper 1610/1610 each, CodeQL 13 = 13 | — |

agent-verify `39818055` otherwise: lint-delta +0/+0, tsc 0, `next build` ok, v1v2-parity 123/123, rpc-budget 36/36, CodeQL
security-extended head 13 = base 13, 0 new by rule+file+message.

Reading: rows 4, 6 and 9 — vitest red only on 5 s timeouts in files this branch does not touch (the diff has no file
vitest collects), and untouched main is red on the same files under the same load. Rows 2, 3 vs 5 — the timing test sits in
an untouched file, but this branch failed it 3 of 4 times while main passed 2 of 2 at the same hour: the two new
property files burned 8.9 s of CPU (6.51 s + 2.39 s user) beside it. Fix attempt 1 (`39818055`): parse each fake
timestamp once and index the bound checks; same seeds, same assertions, same check counts (613,857 and 33,415 +
18,096), the set-based definition still asserted on a sample — 3.47 s (1.73 s + 1.74 s user). 1563 existing tests + 47
new = 1610; no existing test file is modified (`git diff --name-status origin/main`).

---

# Round 2 (A88 audit, design 120b) — tables R1–R9

## R1. The audit's probes as tests (`active-scan-probes.test.mjs`, Node 22). a9f12d9a = scratch worktree at the audited head with this round's fixture, testlib and probe file copied in

| Probe | a9f12d9a | branch |
|---|---|---|
| S-1 flood 15 / 16 / 30 rows per cycle, scan scaled to 100, 40 cycles | ✖ ×3 `flood 15/cycle (oldest row asked at cycles 0): row …000010 present in cycles 0..0 (M=60 …, bound 1) was never asked` — the oldest row asked once in 40 cycles | ✔ ×3 |
| S-1 flood 30/cycle at SCAN_CAP 1000 (980 → 1340 rows, 13 cycles) | ✖ `(M=980, … bound 1) was never asked canExecute; next ask at 1` | ✔ |
| S-2 503 on the scan read, 0.5 / 2 / 10 % of 200 cycles, 200 rows, scan 50 | ✖ ×3 `after the fallback cycle 99 the scan restarted at row 15 instead of continuing at row 85` (24 → row 160, 4 → row 60) | ✔ ×3 |
| S-2 10 % at SCAN_CAP 1000 (2000 rows, 30 cycles) | ✖ `(M=2000, fallback cycles=0, bound 2) was never asked canExecute; next ask at 2` | ✔ |
| S-3 A (receipt held) – B (tick) – A ends – C, 45 rows, streak rows 16..25 | ✖ `after cycle 4, 10 of the 10 active rows lost their ADR-026 streak` (and 2 cycles ran at once) | ✔ (B skipped) |
| S-4 count read throws / hangs; wrap read throws / hangs (5 s limit rewritten to 100 ms) | ✖ `cycle 2: fetch failed`, `cycle 2 did not finish within 3000 ms (hung)`, `cycle 8: fetch failed`, `cycle 8 … (hung)` | ✔ ×4 |
| S-5 gas SKIP once on the ready row (300 rows; and scan scaled to 50) | ✖ ×2 `the ready order skipped by gas in cycle 9 was not executed in cycle 10` | ✔ ×2 (cycle 0 SKIP, cycle 1 fill) |
| S-8 500 rows, restart every 10 cycles (50 cycles) | ✖ `350 of 500 rows never asked across 5 processes` | ✔ |
| S-8 300 rows, scan 50, restart every 3 cycles (15 processes) | ✖ `255 of 300 rows never asked across 15 processes` | ✔ |
| Owner: 40 unanswerable rows + one walked within 3 cycles (2 variants) | ✔ ×2 (round 1's window also rotated) | ✔ ×2 |

Totals (the file as restored at `df38ad6b`, identical to `11502c78`): a9f12d9a 17 fail / 2 pass; branch 19 / 19. Found while writing S-4: with the wrap read failing, the cursor sat on the
newest row, the next cycle read an empty page and logged `No active orders` (returning 0 = idle cadence) although rows
existed. Fixed before commit: no head ⇒ the next scan starts at the oldest row (`active-window.js:210`), and an empty page
whose wrap failed is a scan fallback (`executor.js:844`). Found while writing S-3: the fixture faked `Date.now()` but not
`new Date()`, so lock stamps and the stale-unlock cutoff used different clocks; `withFakes` now fakes both.

## R2. The bound and the flood the creation limits allow

Bound (`active-window.js` header; checked by `checkScreenBound`, `active-scan.testlib.mjs`): every active row is asked
canExecute at least once every ceil(M / 1000) cycles, plus one cycle per fallback cycle. To hide a row a flood must add
1000 rows per cycle (2000 per minute). Creation limits in code: 10 creates per minute per IP (`src/lib/kv-rate-limiter.ts:45`,
`ORDER_CREATE_RATE_LIMIT`, checked in `src/app/api/orders/route.ts:107`) and 20 orders per wallet created in the last
60 min still active or executing (`route.ts:76` `MAX_ACTIVE_ORDERS`, `contracts/order-engine/schema.sql:225`); wallets
cost a signature only, and creation does not check funds. So 2000/min needs >= 200 IPs and >= 6000 fresh wallets per
hour. One IP flat out adds 5 rows per cycle (0.5 % of a scan): 14,400 rows a day; unexecutable rows stay active until
their expiry (<= 90 days), so a sustained one-IP flood grows a rotation by about 14 cycles (7.5 min) per day of flooding.

## R3. Calls per steady-state cycle, shipped executeCycle vs origin/main's (`7bd3ec12`; executor.js unchanged since `bfe26155`)

Fake chain and PostgREST; limit orders with a price feed (main's worst case: it reads the feed for each examined
non-DCA row); the cycle-start/end observability reads (balance, freeze flag, ETH/USD) are the same in both and not
counted. "None ready" = every row answers false; "5 ready" = the 5 oldest answer true and fill this cycle.

| M | main RPC | main Supabase | branch RPC | branch Supabase |
|---|---|---|---|---|
| 0 | 0 | 2 (stale-unlock PATCH, GET) | 0 | 2 |
| 1, none ready | 2 (feed read, canExecute) | 4 (+ lock, unlock) | 1 (aggregate3) | 2 |
| 15, none ready | 30 | 32 | 1 | 2 |
| 100, none ready | 30 | 32 | 2 | 2 |
| 1000, none ready | 30 | 32 | 20 | 2 |
| 1500, none ready (rotating) | 30 | 32 | 20 | 3 (+ HEAD count) |
| 15, 5 ready | 30 (5 × feed, canExecute, gas price, block, executeOrder, receipt) | 22 | 31 (the same + 1 aggregate3) | 22 |
| 1000, 5 ready | 30 | 22 | 50 (the same + 20 aggregate3) | 22 |
| 1500, 5 ready | 30 | 22 | 50 | 23 |

At a wrap the rotating scan adds one GET (the head page) instead of the HEAD count; a carried row the page does not hold
adds one GET per 100 ids. Idle backoff unchanged (`idle-backoff.js`): 0 rows ⇒ the same 2 Supabase calls and no RPC.

## R4. Differential against origin/main (`active-scan.differential.mjs`, hand-run; reference = `git show origin/main:contracts/order-engine/executor/executor.js`)

500 runs (seeds 53759 + i·7919, i = 0..499), 12 cycles each, <= 15 active rows, no Supabase or RPC failure; personas
ready-once, never, flaky (per row and cycle), shared-balance (one fill empties the owner), expired, DCA (true, never
fills: infra keeper-config miss in both); gas SKIP on ~8 % of cycles; rows added between cycles.
Batches 0–99 / 100–199 / 200–299 / 300–399 / 400–499: 1001 / 1018 / 1003 / 1023 / 1051 fills by main; 0 runs with a
different executed list or order (6000 cycles, 5096 fills). Not modelled: an execution that makes ANOTHER row ready in
the same cycle (the pre-screen asked at the cycle's start; main asks each row as it reaches it): that row fills one cycle
later on the branch.

## R5. Seeded properties

- `active-scan-property.test.mjs` (shipped cycles, real fills): 20 seeds (0x7e57 + i·104729) × 80 cycles, half with
  SCAN_CAP rewritten to 25: 22,528 bound checks, 1,725 fills, 8,674 row writes checked, 115 fallback cycles (scan 503 on
  ~4 % of cycles, a failed Multicall3 chunk on ~3 % of chunks, gas SKIP on ~5 %). No order filled twice; <= 5 fills
  per cycle; every row asked within ceil(M/SCAN) + fallback cycles; a row written only when that cycle's pre-screen said
  true, could not answer it, or its expiry passed.
- `active-window.test.mjs` (pure): 30 seeds (0x5ec4 + i·7919) × 120 cycles, 1–300 rows, churn (ties, back-dated rows),
  failed scan and wrap reads, a random first page: bound checked > 20,000 times; no entry of an active row ever pruned;
  a removed row's entry goes by the second complete scan after it left (> 100 removals checked).

## R6. Mutation proof (scratch copies of the executor directory, one textual mutant each; the five active-scan /
active-window test files, Node 22; then the differential for M8). Counts from the run on the probe file as it is now
(`11502c78` = `df38ad6b`); a second run on `cc262b34`'s weakened file killed the same mutants (M4 by 4 instead of 5)

| Mutant | Killed by |
|---|---|
| M1 pre-screen trusted: the path skips its own canExecute when the pre-screen said true | 7 tests (S-5 ×2, S-3 overlap, owner "becomes answerable", S-3 two-scans, gas SKIP, v2 builder equality) |
| M2 carry-over dropped (`carryIds = []`) | 4 (S-5 scaled, carry-over leads, gas SKIP, MAX_BATCH mid-list) |
| M3 overlap guard removed | 2 (S-3 overlap probe, one-tick-at-a-time) |
| M4 a scan fallback moves the cursor (round 1's behaviour) | 5 (S-2 ×4 incl. the full-size one, the shipped property) |
| M5 a streak pruned after ONE complete scan | 3 (S-3 two-scans shipped, two keepIdsAfterScans units) |
| M6 the audit's M6 here: every walked row counted as reached | 3 (carry-over leads, gas SKIP, MAX_BATCH mid-list) |
| M7 the one-by-one budget does not rotate | 4 (owner's test, Multicall3 absent, two planWalk units) |
| M8 carried rows literally first (the reading the owner did not choose) | 0 test files — the differential: 9 of 100 runs differ in order |

## R7. Multicall3 on the real chains (owner answer 2: read-only, public keyless RPCs, nothing from the project sent)

`eth_getCode(0xcA11bde05977b3631167028862bE2a173976CA11)` and ONE `aggregate3([{target: Multicall3, allowFailure: true,
callData: getChainId()}])`, 2026-11-18 14:52Z:
- Base, `mainnet.base.org`, block 59115860: 3808 bytes, code keccak `0xd5c15df6…e770891`; aggregate3 → 1 result, success, getChainId = 8453.
- Arbitrum One, `arb1.arbitrum.io`, block 525352000: 3808 bytes, same code keccak; aggregate3 → success, getChainId = 42161.

## R8. Keeper suite and CPU (Node 20.20.2 and 22.23.5, `node --test` in `contracts/order-engine/executor`)

At `a01d9251` (a9f12d9a merged with main, before round 2): 2098/2098 (Node 22). At `cc262b34`: 2136/2136 on Node 20 and 22.
At `df38ad6b` (probe file restored): 2137/2137 on Node 20 and 22 (load 8.7 at the start).
User CPU per new file (Node 22): probes 9.75 s at `11502c78` and again now (13.8 s measured at load ~8), cycle 0.47 s, property
1.80 s, active-window 0.60 s, active-window-cycle 0.41 s. `cc262b34` had cut the probes to 3.98 s by weakening them (below,
and CAPITALS in the feedback file); `df38ad6b` reverted that. chain-verify.test.mjs:765 passed in every run beside it.

## R9. The one verify run (owner rule: when no other verify or CodeQL runs and the 1-minute load is under 10)

Quiet checks 15:36:09Z load1 7.04 and 15:36:39Z load1 5.31, no other agent-verify or CodeQL process; `brew` stubbed out of
PATH (this goal forbids running brew; agent-verify fell back to `/opt/homebrew/opt/node@20` / `node@22`); the
OpenZeppelin submodule not initialised (CodeQL head and base on the same tree).
`PATH=<stub>:$PATH scripts/agent-verify.sh --keeper --codeql` on `c4c9a878` (base origin/main `7bd3ec12`), exit 0:

```
suite:       PASS 11090 tests passed, 0 failed, 520 files
lint-delta:  PASS errors +0, warnings +0 (11 changed files; head 0 err/0 warn, base 0 err/0 warn)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      PASS node20:2136-pass/0-fail/0-cancelled node22:2136-pass/0-fail/0-cancelled
17 files changed, 3779 insertions(+), 54 deletions(-)   (diff --stat origin/main...HEAD: rounds 1 and 2)
RESULT: PASS
```

`node scripts/gen-claude-state.mjs --check`: `CLAUDE.md state block is current`. `gitleaks git --log-opts=a9f12d9a..HEAD`:
67 commits scanned, no leaks found.

The first verified head `c4c9a878` carried `cc262b34`'s weakened probe file. `df38ad6b` restored it byte for byte to
`11502c78`. Owner answer 5: a second run on the pushed head. Quiet checks 16:11:44Z load1 3.18 and 16:12:15Z 3.55, no other
verify or CodeQL; same brew stub; `agent-verify --keeper --codeql` on `4ec3e258` (base origin/main `85a6f9cb`), exit 0:

```
suite:       PASS 11090 tests passed, 0 failed, 520 files
lint-delta:  PASS errors +0, warnings +0 (11 changed files; head 0 err/0 warn, base 0 err/0 warn)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      PASS node20:2137-pass/0-fail/0-cancelled node22:2137-pass/0-fail/0-cancelled
17 files changed, 3795 insertions(+), 54 deletions(-)   (diff --stat origin/main...HEAD)
RESULT: PASS
```
gen-claude-state: current. gitleaks `c5cf3c52..HEAD`: no leaks.

## R10. Round-2 feedback (moved here to keep the round-2 section of the feedback file to one screen)

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
- `cc262b34` weakened the probe file to save CPU and its message said "No assertion changed": wrong; reverted in `df38ad6b`
  (CAPITALS in the feedback file). The CPU concern stands: the probe file costs ~10 s of CPU, more than round 1's 8.9 s file
  that turned chain-verify.test.mjs:765 red beside it on a loaded Mac; it passed in every run here.
