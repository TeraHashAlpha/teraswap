# fix/keeper-active-orders-window — round 3 tables (companion of `…round3.md`)

Code commits: `358e62a7` (round 3) and `ce55e768` (a stale comment). Lines are at `ce55e768`; `executor.js` = `contracts/order-engine/executor/executor.js`, `aw.js` = `…/active-window.js`.

## T-R3-1 Findings → fix → tests

| Finding | Fix (file:line) | Tests |
|---|---|---|
| R2-1 (H) failed chunk held the scan; 2 burners freeze rotation / slow everything | no hold: `executor.js:1131` (advanceActiveScan on the scan as read), `:2036`; truncateScan removed `aw.js:234`. Bisect `aw.js:321`, wired `executor.js:1044-1110` (budget 40 `:363,1079`). Alone-ask with gas `:1013` (3,000,000 `:364`). Hostile-only classifier `aw.js:254`. Quarantine `aw.js:371`, `executor.js:446,1087,1099`; re-asks 10/cycle `:366`; visible: line `aw.js:539`, `/health` `executor.js:2987-2999`, alert `:1184` (at 5 `:367`); complete scan on reads, prune `:1131-1150`. Expired still walked (planWalk unchanged) | `active-scan-poison` (3), `active-scan-round3` R2-1 (8), `active-scan-cycle` ROUND 3 test, property, `prescreen-bisect-replay` (5) + Foundry `PrescreenBisect.t.sol` (6), `active-window` unit (bisect 6, classifier 4, quarantine 1) |
| R2-2 (H) 5 s read limit made a slow freeze read fail-open | owner decision "error = frozen": `executor.js:1460-1491` (only `[{"frozen":false}]`-shaped passes), `:1835-1854`, `/health` + alert `:1495` | `active-scan-round3` R2-2 (12: the 5.5 s read, the 10-row table, /health) |
| R2-3 (M) fallback cycle overwrote the carry list | `executor.js:2818`; ADR-026 note corrected | `active-scan-round3` R2-3 |
| R2-4 (L) failed wrap read not flagged; bound omitted restarts | `executor.js:879,1990`, flag `aw.js:519`, `/health` `scanWrapFailedCycles`, alert kind `active-scan-wrap-failed`; bound text `aw.js` header, runbook § 9 | `active-scan-round3` R2-4; restart rig (T-R3-7) |
| Watchdog + limits (owner answer 3) | watchdog `executor.js:2892,2918` (5 min `:370`), boot cycle guarded `:3335`; Supabase writes 10 s `:783`; /api/swap 65 s `:1589`; KMS 10 s `kms-signer.js:66,85,107` | `active-scan-round3` watchdog (fake clock) + 2 hanging-cycle tests; `kms-request-timeout` |

## T-R3-2 The new tests on the audited head 16fb740c (the new fixture and test files over 16fb740c's executor.js / kms-signer.js)

`node --test active-scan-poison.test.mjs active-scan-round3.test.mjs kms-request-timeout.test.mjs` on 16fb740c: **tests 30, pass 0, fail 30**. On `ce55e768`: 30/30 pass.

| Test (16fb740c) | Why it failed there |
|---|---|
| 1200 rows, burners fail one chunk every cycle | `row #300 ready from cycle 10 executed at cycle never (within 12 cycles)`; every line `fallback=prescreen-1of20` |
| 24 burners among 600 / 1000 | `the ready row #591 was not executed within 6 cycles`; every line `prescreen-12of12` / `12of20` |
| quarantine ×5, hostile-only ×3 | no quarantine / bisect: `quarantined=` absent, `bisectCalls` undefined, the rows are never asked alone |
| slow freeze read 5.5 s, frozen=true | the DCA row reached the path (`treating as NOT frozen`) |
| freeze: HTTP 503 / 404 / network / not JSON / not a list / not boolean / no row / time limit | the DCA row passed (main's fail-open + the 5 s limit) |
| freeze: answer false / answer true | **behaviour equal to 16fb740c and main**; failed only on the new `/health` field (`freezeReadFailure` undefined) |
| /health fields, boot-cycle guard (source anchors) | fields / `runOneCycleAtATime(runTick)` absent |
| watchdog (fake clock) | `one page at 5 minutes: expected 1, actual 0` |
| every call hanging / every call after the scan hanging | `did not finish within 10000 ms (hung)` / `15000 ms (hung)`: the stale-unlock and lock PATCH had no limit |
| R2-3 fallback keeps the carry list | fallback line `carried=0` |
| R2-4 failed wrap read | `no cycle flagged fallback=scan-wrap` |
| KMS endpoint never answers | `the KMS request was still waiting after 8 s` |

## T-R3-3 The bisect (design 120c §6), gas model at an eth_call cap of 50M; `active-scan-poison.measure.mjs`, 5 seeds × 40 cycles (16fb740c: × 80)

| M (rows) | P (burners) | worst delay of a healthy row, head | 16fb740c | head: no chunk fails from cycle | max bisect calls / cycle | quarantined at the end |
|---|---|---|---|---|---|---|
| 600 | 24 | **1** | 26 | 2–3 | 40 | 17–21 |
| 1000 | 24 | **1** | 27 | 1–2 | 40 | 14–20 |
| 1200 | 24 | **1** | 80 (never, frozen scan) | 1–2 | 35 | 13–19 |
| 600 | 200 | **12** | 39 | 12–13 | 40 | 198–199 |
| 1000 | 200 | **12** | 66 | 12–13 | 40 | 193–200 |
| 1200 | 200 | **12** | 80 (never) | 12–16 | 40 | 196–199 |

Delay = cycles from any start cycle until the keeper next gets an answer for the row (pre-screen answered, or the path asked it): the delay of a row that becomes ready then. Burners not quarantined at the end (P=24: 3–11) are lone burners in a chunk: they never fail it, lose only their own answer and go to the 15-row budget (their own path call ends as an uncounted out-of-gas infra miss, as on main).

Per chunk within the budget: isolating P burners costs <= 7P calls (unit property over 500 seeded layouts, caps 31M–550M; the worst observed ratio is printed by the test); measured ~2.5 calls per burner, so 40 calls isolate ~16 burners per cycle (P=200: 14–19 new per cycle); a 50-row chunk with 10 burners: 25 calls at 50M, 21 at 550M (replay). Guaranteed: >= 5 burners per cycle (40 / 7).

Foundry (`PrescreenBisect.t.sol`, real Multicall3 runtime code — Base and Arbitrum One identical, 3808 bytes, keccak `0xd5c15d…0891` — and the real V3 executor): 6/6. Replayed keeper calls: 1 burner 1 call (chunk answers, 49 healthy answered), 2 burners 5 calls, 10 burners 25 (50M) and 21 (550M) calls; every recorded outcome matched the EVM; the burners failed alone; every healthy row answered. Honest `canExecute` asked alone with the 3,000,000 cap: DCA 20,802 · limit 28,523 · stop-loss 16,025 · limit (false) 13,924 gas; a burner alone fails after ~2.93M. Minimum caps for two burners in 50 rows (EVM; gas model within 6 %): (0,49) 47M · (47,49) 31M · (3,41) 133M · (24,25) 300M · (0,1) 571M; one burner never fails a 50-row call above ~18M.

## T-R3-4 Every external await of a cycle and its limit (owner answer 3)

viem's http transport: 10 s per try, 3 retries (a timeout is retried), backoff 0.3 + 0.6 + 1.2 s ⇒ ~42 s per RPC request (`node_modules/viem/_esm/clients/transports/http.js:16`, `utils/buildRequest.js:10,141`). Telegram: 10 s (`alert.js:92`, every alert).

| Await (in order) | Limit | At the limit |
|---|---|---|
| balance read `getBalance` | ~42 s (viem) | rpcDown, rpc alert, cycle goes on |
| rpc-auth monitor: paused-state publish / auth alert | 5 s (`runtime-config.js:133`) / 10 s | logged, never throws |
| idle-window outflow check + alert | ~42 s / 10 s | logged |
| **freeze read** `circuit_breaker` GET | 5 s | **FROZEN this cycle** (was: not frozen) |
| freeze transition / read-failure alerts | 10 s | logged |
| ETH/USD `latestRoundData` + low-gas alert | ~42 s / 10 s | null, signal skipped |
| stale-unlock PATCH | **10 s (new; Node fetch alone: 300 s headers)** | throws ⇒ `Cycle error` (as on a network error) |
| scan reads: page, random page, wrap, count HEAD, carried re-reads (<= 10 × 100 ids), fallback | 5 s each | fallback / `scan-wrap` / `active=?` |
| scan / wrap / pre-screen fallback alerts | 10 s each | logged |
| Multicall3 chunk (<= 20 per cycle) | 5 s each (viem 10 s underneath) | bisected, or rows to the 15-row budget |
| bisect calls | <= 40 × 5 s | rows unresolved ⇒ 15-row budget |
| quarantine re-asks | <= 10 × 5 s | stays quarantined |
| quarantine alert | 10 s | logged |
| DCA price sources: DefiLlama batch / CoinGecko leg / Chainlink reads | 5 s / 20 s budget (+ one 429 wait <= 10 s + 5 s) / ~42 s each | source absent ⇒ quorum rules (ADR-024) |
| per walked row: expired / unlock PATCH, **lock PATCH** | **10 s (new)** | throws into the row's catch ⇒ handled as before (infra miss) |
| per walked row: new-DCA alert, ops alerts | 10 s | logged |
| per walked row: debug `latestRoundData`, path `canExecute` | ~42 s each | logged / infra miss |
| per walked row: **POST /api/swap** | **65 s (new; the route stops at 60 s)** | `swap-api:network` infra miss (as before) |
| per walked row: GET /api/quote (deviation reference) | 5 s | fail-open (as before) |
| per walked row: `getGasPrice` + `getBlock` | ~42 s | row catch ⇒ infra |
| per walked row: `writeContract` = nonce / estimate RPCs + **KMS sign** + `sendRawTransaction` | ~42 s each + **10 s (new; the SDK sets none)** + ~42 s | no tx sent ⇒ infra miss (keeper-*) |
| per walked row: `waitForTransactionReceipt` | 180 s (viem default) | `receipt-unavailable` infra miss |
| per walked row: status patch (<= 3 sends), execution record GET + POST | 10 s each / 5 s + 10 s | logged / reconciled by backfill (as before) |
| per walked row: failure handling patch + alert | 10 s × <= 3 + 10 s | throws ⇒ `Cycle error` |
| end: balance read + outflow alert; price-source summary | ~42 s + 10 s; <= CoinGecko budget | logged |
| idle probe tick: stale-unlock + scan reads | 10 s + 5 s each | as above |

Every await has a limit, so a cycle ends; its worst case is their sum — tens of minutes with 5 fills and many walked rows on a hung RPC. Hence the **watchdog**: a cycle past 5 min pages `cycle-watchdog` once and sets `/health` `longCycles` / `cycleRunningSec`; it is not killed (test: fake clock, `active-scan-round3.test.mjs`). Measured with every limit scaled (reads 60, writes 80, chunk 50, swap 90, RPC 70 ms): every call hanging ⇒ the cycle ends at the stale-unlock write within the sum (280 ms) + 2 s; every call after the scan hanging ⇒ it ends within chunk + 40 bisect + 15 rows × 2 writes (< 6.7 s) + 2 s; on 16fb740c both hung.

## T-R3-5 Freeze read: outcome per answer, head against origin/main 85a6f9cb and 16fb740c (`freeze-read.differential.mjs`; read limit 100 ms where the file has one — main has none)

| circuit_breaker answers | head (`ce55e768`) | origin/main | 16fb740c |
|---|---|---|---|
| `[{"frozen":false}]` | passes | passes | passes |
| `[{"frozen":true,…}]` | FROZEN | FROZEN | FROZEN |
| HTTP 503 | **FROZEN** `freeze read failed (HTTP 503) -- treating as FROZEN this cycle` | passes (`… NOT frozen`) | passes |
| HTTP 404 (no table) | **FROZEN** | passes | passes |
| network error | **FROZEN** | passes | passes |
| body not JSON | **FROZEN** | passes | passes |
| body not a list | **FROZEN** | passes (silently) | passes |
| `frozen` not a boolean | **FROZEN** | passes (silently) | passes |
| empty list (no `dca` row) | **FROZEN** (owner answer 1) | passes (silently) | passes |
| 300 ms, frozen=false | **FROZEN** `freeze read timed out -- treating as FROZEN this cycle` | passes (waits) | passes (`aborted due to timeout -- NOT frozen`) |
| 300 ms, frozen=true | FROZEN (timed out) | FROZEN (waits) | **passes** (the A91 R2-2 bug) |
| never answers | FROZEN (timed out) | the cycle hangs | passes (timed out) |

Every head FROZEN cycle: DCA rows left `active` and unlocked, nothing counted, limit / stop-loss unaffected, `/health` `freezeReadFailedCycles` / `freezeReadFailure`, alert `freeze-read-failed` (first cycle, then hourly). The 5.5 s real-time test: `active-scan-round3.test.mjs`.

## T-R3-6 Differential, property, mutation

- Differential vs origin/main 85a6f9cb (M <= 15, no failures, wallet that executes): 500 runs (seeds 53759 + i·7919), 6000 cycles, 5096 executions by main, **0 runs with a different executed list** (as in round 2).
- Property (`active-scan-property.test.mjs`, deterministic): 20 seeds × 80 cycles (1 min each), personas incl. poisoned and expired, random scan 503s, Multicall3 transport errors and time limits, gas SKIPs: 20,849 screen-bound checks, 295 ready-row attempt checks, 1,519 executions, 9,516 row writes checked (6 to quarantined rows, all expired), 64 fallback + 56 unresolved-pre-screen cycles, 356 rows quarantined, 106 alone-asks while quarantined — none closer than 30 min; no double execution, <= 5 per cycle, no poisoned row executed.
- Mutation (scratch copies, the scan test files): M1 the scan holds on a failed chunk — KILLED (ROUND 3 cycle test, property); M2 bisect budget ignored — KILLED (3: Multicall3-absent, nothing-answers, 200-burners); M3 quarantine never released — KILLED (re-ask/release test); M4 freeze timeout treated as not frozen — KILLED (5.5 s test, time-limit row); M5 fallback clears the carry list — KILLED (R2-3 test).

## T-R3-7 Restarts (R2-4 bound text; `active-scan-restart.measure.mjs`, 5 seeds × 60 cycles)

| Active rows | ceil(M/1000) | no restart | a restart every cycle | every 2 cycles |
|---|---|---|---|---|
| 1,500 | 2 | 2 | 7 | 3 |
| 2,500 | 3 | 3 | 14 | 12 |

Worst gap (cycles) between two screenings of a row. A fresh process starts at a random page (S-8), so a crash loop is outside the ceil(M/1000) bound; stated in the runbook § 9 and the `aw.js` header.

## T-R3-8 Feedback (edge cases, wrong assumptions, concerns)

- **Assumption that was wrong (the design's):** "every external await already has a limit" — KMS (SDK: none), Supabase writes and POST /api/swap (Node fetch's 300 s header timeout only). Asked once; owner answer 3 added limits.
- **Assumption that was wrong (mine):** "two burners fail a chunk". Foundry: it depends on their positions and the RPC's eth_call cap (31M–571M for two in 50 rows); one never does above ~18M. The test fake uses a gas model calibrated on those measurements; exact cases go through the Foundry replay.
- **Edge case:** viem keeps no HTTP status when a 5xx carries a JSON-RPC error body (it builds `ExecutionRevertedError`), so such an answer reads as "execution": it is bisected, and quarantines a row only while other calls answer (`aw.js:254` comment, unit test).
- **Concern:** a row whose view merely REVERTS (not a burner) is quarantined when it sits in a chunk that burners made fail (owner answer 2 includes "a revert"); main would count its misses to `failed`, quarantined it stays `active` until expiry (asked every 30 min). Outside such chunks it is walked as before.
- **Concern:** lone burners (one per chunk) are never quarantined (design: only rows of failed chunks are asked alone); each costs one slot of the 15-row budget and one path eth_call burning the RPC's cap per walk (ADR-026 backoff spaces them).
- **Concern:** a hung RPC (every call timing out) makes a pre-screen up to (chunks + 40 + 10) × 5 s; the watchdog pages at 5 min.
- **Concern (open question for the owner, from the design):** the API's create route (`src/lib/dca-freeze.ts`) still fails OPEN; only the keeper changed. `supabase/circuit-breaker.sql`'s header comment ("readers MUST fail OPEN") is now wrong for the keeper; not edited (schema file, out of scope).
- **Test gap:** the KMS limit is tested against a local stand-in endpoint, not AWS; the Supabase write limit against the fake PostgREST.
