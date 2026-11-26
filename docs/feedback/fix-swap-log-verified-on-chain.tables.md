# Tables: fix/swap-log-verified-on-chain (ADR-029 phase 1, goal 133)

Evidence for `fix-swap-log-verified-on-chain.md`. Line numbers are of the last code commit.

## 1. Details A to G: where it is, and the test

| Detail | Code | Test |
|---|---|---|
| A.1 input rejected, no chain read | `src/lib/swap-verify/verify-swap-on-chain.ts:386-390` | `verify-swap-on-chain.test.ts` "A.1 input" (17 cases, 0 reads each) |
| A.2 server RPC, timeout, one retry, missing = not_found | `chain-read.ts:19-23` (4 s, 2 attempts, 1.5 s before a null is asked again), `:72` (`serverOnlyRpcUrl`), `:83-84` (endpoint must prove its chain), `:86-101` (the one retry: after an error, or after a null); `src/lib/rpc-env.ts:163`; `verify-…ts:397-406, :427-441` | `chain-read.test.ts` (31), `rpc-env.test.ts` "server-only order" (4), `verify-….test.ts` "A.2 and fail closed" (32) |
| A.3 `tx.from` is the wallet | `verify-…ts:424-425` | "A.3 wrong sender" (fee_collector and router, 3 chains each) |
| A.4 kind | `verify-…ts:408-422` (fee_collector `:417`, router `:418`, cow `:421` and `cowTradesOf :336`) | "kind fee_collector", "kind router", "kind cow", "chain-aware" |
| A.5 status | `verify-…ts:443-444`; reverted with logs is malformed `:441` | "A.5: the receipt status…", reverted fixtures (V1 FeeCollector, 0x) |
| A.6 derived sides | FeeCollector event `:287`, Transfer legs `:252`, Trade `:336, :357` | every "derived" expectation; "two candidates", "a transfer leg is…", "another user", "itself emitted it" |
| A.7 what is derivable | section 3 below | real receipts, measured |
| B POST | `src/app/api/log-swap/route.ts:61-156`; `src/lib/swap-log/input.ts:40-97`; `symbols.ts:25-38`; `store.ts:18` (cap), `:108-121` (insert: status, hash, USD, fee, mev fixed) | `route.post.test.ts` (53) |
| C PATCH | `route.ts:159-180, :194-231`; `src/lib/swap-log/confirm.ts:181-228` (row choice `:162-178`, one update `store.ts:213-222`, trackers `confirm.ts:103-144`) | `route.patch.test.ts` (42) |
| D readers | `src/lib/swap-log/public-filter.ts:15, :29`; section 4 below | `swaps-readers.differential.test.ts` (26), `public-filter.test.ts` (16) |
| E migration | `supabase/migrations/20261125120000_swaps_verified.sql:59-95`; mirror `supabase/schema.sql:203-246`; before it is applied: `store.ts:65-75`, `route.ts:85-90, :219-224` | `fake-swaps-db.schema.test.ts` (11), `route.unmigrated.test.ts` (9) |
| F script | `scripts/swaps/verify-stored-swaps.ts` (`:75` `process.exitCode`), `verify-stored-swaps-lib.ts:101` (match rule), `:136`, `:195`, `:341` (apply writes two columns), `:370` | `scripts/swaps/verify-stored-swaps.test.ts` (27); the real CLI run in section 5 |
| G tests | all of the above, plus `route.incident-replay.test.ts` (9), `route.property.test.ts` (2 seeds), `e2e/swap-log/swap-to-history.pw.ts` (v1, v2) | sections 2 and 5 |

## 2. The incident replayed: before (main 5465ceb0) and after

The same file, `src/app/api/log-swap/route.incident-replay.test.ts`, run on a checkout of main (only
`src/test-utils/fake-swaps-db.ts` copied in) and on this branch. Main: 9 of 9 shapes FAIL. Branch: 9 of 9 pass.
Columns: rows whose status the caller chose / rows main's public counters read as a swap (confirmed, or pending with a
hash) / alerts fired / rows whose symbol is the caller's text / largest USD stored / rows carrying a hash the chain never
confirmed / another wallet's pending row changed.

| Shape (requests) | main | branch |
|---|---|---|
| 1 invented wallet and hash, POST status confirmed (13) | 13 / 13 / 0 / 0 / 3,400 / 13 / no | 0 / 0 / 0 / 0 / none / 0 / no |
| 2 repeated-byte and zero hashes, PATCH status confirmed (12) | 6 / 6 / 0 / 0 / 3,400 / 6 / no | 0 / 0 / 0 / 0 / none / 0 / no |
| 3 every status by POST (6) | 5 / 1 / 0 / 0 / 3,400 / 0 / no | 0 / 0 / 0 / 0 / none / 0 / no |
| 4 every status by PATCH (12) | 5 / 2 / 1 / 0 / 3,400 / 6 / no | 0 / 0 / 0 / 0 / none / 0 / no |
| 5 XSS string and NUL byte as symbols (2) | 2 / 2 / 0 / 2 / 3,400 / 0 / no | 0 / 0 / 0 / 0 / none / 0 / no |
| 6 500 WETH declared, statuses filled, reverted, confirmed (3) | 3 / 1 / 3 / 0 / 1,700,000 / 0 / no | 0 / 0 / 0 / 0 / none / 0 / no |
| 7 a token contract as the wallet (3) | 1 / 0 / 0 / 0 / 3,400 / 1 / no | 0 / 0 / 0 / 0 / none / 0 / no |
| 8 PATCH aimed at another wallet's pending row (3) | 0 / 1 / 1 / 0 / none / 1 / YES | 0 / 0 / 0 / 0 / none / 0 / no |
| 9 all of it: 117 POST and 117 PATCH from 13 wallets | 99 / 38 / 47 / 54 / 1,700,000 / 60 / YES | 0 / 0 / 0 / 0 / none / 0 / no |

On the branch the invented wallets end with at most 5 pending rows each (the cap), every one private: status pending, no
hash, no USD, catalog symbols. In shape 6 main fired the large-trade alert for all three rows, also the two whose status
kept them out of the public volume (ADR-029 section 1, as corrected).

## 3. What sides can be derived, per source and chain (A.7)

Measured with the real CLI (`scripts/swaps/verify-stored-swaps.ts`) over 435 real (transaction, wallet) claims read from
public nodes on 2026-11-25 and replayed through local stub RPCs. "Both" = both tokens and amounts derived.

| Chain | Kind | Source (derived) | Real txs | Both | Sold side only | Neither | Reverted |
|---|---|---|---|---|---|---|---|
| Ethereum | fee_collector V2 | kyberswap, velora, uniswapv3 | 34 | 34 | 0 | 0 | 0 |
| Base | fee_collector | kyberswap 9, uniswapv3 2, velora 1 | 12 | 12 | 0 | 0 | 0 |
| Arbitrum | fee_collector | kyberswap | 2 | 2 | 0 | 0 | 0 |
| Ethereum | fee_collector V1 (frozen) | kyberswap, velora, uniswapv3; `unknown` when reverted | 13 | 7 | 4 | 0 | 2 |
| Ethereum | cow | cowswap (9 sent to the settlement contract, 7 to a solver's contract) | 16 | 16 | 0 | 0 | 0 |
| Base | cow | cowswap (4 direct, 8 via a solver) | 12 | 12 | 0 | 0 | 0 |
| Arbitrum | cow | cowswap (7 direct, 8 via a solver) | 15 | 15 | 0 | 0 | 0 |
| Ethereum | router | 0x | 289 | 185 | 100 | 2 | 2 |
| Base | router | 0x | 25 | 18 | 7 | 0 | 0 |
| Arbitrum | router | 0x | 17 | 9 | 8 | 0 | 0 |

Reading it by source of the official client:
- **Every source that goes through the FeeCollector** (1inch, velora, kyberswap, uniswapv3, sushiswap, curve; odos,
  openocean, balancer are disabled): both sides, ETH included, from the FeeCollector's own `SwapWithFee` event. All 48
  real swaps of the current FeeCollector on the three chains derive both sides. The FeeCollector sample holds the three
  routers real users have used so far (KyberSwap, Augustus, Uniswap SwapRouter02); the rule does not depend on the router.
- **cowswap**: both sides from the Trade event, 43 of 43, whoever sent the settlement. A CoW order that "buys ETH" in the
  app is an order for WETH (`cow.ts:258`): the verified row says WETH, where main's row said ETH.
- **0x** (the only source the app sends straight to a router; bebop is disabled): token to token both sides; token to
  ETH loses the bought side, because ETH arriving leaves no log (115 of 331 sampled, 35%). Its sold side and USD are
  still derived, and the public volume sums the sold side. Two candidates on a side: both null (2 of 331).
- Old rows through the frozen FeeCollector V1 (13 real swaps): its event has no output, so token to ETH loses the bought
  side (4), and a reverted call's source is `unknown` (2).
- Not derivable at all, by rule: a transaction sent by a smart-contract wallet or a relayer (`tx.from` is not the wallet:
  rejected), and a transaction to a contract that is none of the three kinds.

## 4. Every caller and every reader

Callers (all in the browser; none changed):

| Call site | Sends | Before | After |
|---|---|---|---|
| `src/hooks/useSwap.ts:1086` CoW order submitted | POST, status pending | 200 `{ ok: true }` | 200 `{ ok: true }` |
| `src/hooks/useSwap.ts:1188` standard swap at confirm | POST, status pending | 200 `{ ok: true }` | 200 `{ ok: true }` |
| `src/hooks/useSplitSwap.ts:611` split leg after its receipt | POST, status confirmed, txHash | 200 `{ ok: true }` | 200 `{ ok: true }`; the leg is verified on the row just inserted |
| `src/hooks/useSwap.ts:1120` CoW settled | PATCH txHash, wallet, mevSavingsActual | 200 `{ ok: true }` | 200 `{ ok: true }` |
| `src/hooks/useSwap.ts:1237`, `:1292` receipt success | PATCH txHash, wallet | 200 `{ ok: true }` | 200 `{ ok: true }` |
| `src/hooks/useSwap.ts:1303`, `:1358` reverted / send error | PATCH status failed | 200 `{ ok: true }` | 200 `{ ok: true }` when the chain says reverted; 202 when it has no such transaction |
| `src/components/SwapBox.tsx:413`, `src/ui/v2/swap/lifecycle/use-swap-lifecycle.ts:206` second PATCH with mev figures | PATCH | 200 `{ ok: true }` | 200 `{ ok: true }`, no chain read (already verified) |

Proved by `route.post.test.ts` ("the official client's three calls"), `route.patch.test.ts` (same wallet again; two
PATCHes together) and the browser run (section 5). `wallet` absent in a PATCH (wallet disconnected): 200 `{ ok: true }`,
nothing read or written, as before.

Readers of `swaps`:

| Reader | File:line | Flag |
|---|---|---|
| `/api/stats` total, top sources | `src/app/api/stats/route.ts:19, :32` | on: verified only |
| `/api/stats` gasless count and sum | `:67-82` (on: counted in the route; off: `gasless_stats()` as before) | on: verified only |
| `/api/analytics` totals and recent-activity list | `src/app/api/analytics/route.ts:38` | on: verified only |
| `/api/analytics/export` | `src/app/api/analytics/export/route.ts:213` | on: verified only |
| `/api/analytics/personal` | `src/lib/personal-analytics.ts:194`; cache key `src/app/api/analytics/personal/route.ts:39` | on: verified only |
| `/api/monitor` metrics, wallet lookup | `src/app/api/monitor/route.ts:138, :75` | on: verified only |
| `/api/health` count, sample | `src/app/api/health/route.ts:85, :96` (the table probe `:55` returns no row: unchanged) | on: verified only |
| weekly surplus report | `src/lib/surplus-report.ts:77` | on: verified only |
| `/api/history` (the wallet's own) | `src/app/api/history/route.ts:87` | never: pending and failed rows stay |
| `validate-execution` surplus write | `src/app/api/monitor/validate-execution/route.ts:103` | a bearer-authenticated write, untouched |
| the swap log itself, the script | `src/lib/swap-log/store.ts`, `scripts/swaps/verify-stored-swaps-lib.ts:325, :343` | not public readers |
| SQL only: `gasless_stats()`, view `quote_build_daily_stats` | `supabase/migrations/20260514…`, `20260912120000…:104` | no app code reads the view; the function is not called with the flag on |

## 5. Differential, property seeds, mutation proof, browser steps

**Differential** (`swaps-readers.differential.test.ts`, seed 20261125, 160 seeded rows, clock fixed). Flag off: status,
headers, body bytes AND the recorded database queries of the nine readers equal
`src/app/api/__goldens__/swaps-readers.main.json` (sha256 62c6430b70297ef9…), recorded by this same file on a checkout
of main 5465ceb0; recorded three times, same bytes. On main the flag-off cases pass (17) and the flag-on cases fail (9
of 9). Flag on: each of the eight public readers answers exactly what it answers, flag off, on a database holding only
the verified rows; `/api/history` is identical on and off.

**Property** (`route.property.test.ts`): seeds 133 and 20261125, 1,000 requests each.

| Seed | POST | PATCH | Rows | Verified | 200 | 202 | 409 | 422 | 429 |
|---|---|---|---|---|---|---|---|---|---|
| 133 | 499 | 501 | 119 | 14 | 326 | 236 | 69 | 18 | 351 |
| 20261125 | 495 | 505 | 115 | 10 | 272 | 255 | 56 | 48 | 369 |

**Browser** (`e2e/swap-log/swap-to-history.pw.ts`; Chromium 1248 headless, production builds, real CSP). Steps: open the
app, the stub wallet (no key, address of a real trade's owner) reconnects, flip the pair, choose USDT, type 649.256721,
swap, review, "Confirm & Sign Order", the order settles after 8 s, open History. The table is run 3, of the last code
commit against main's build.

| | main v1 | branch v1 | main v2 | branch v2 |
|---|---|---|---|---|
| wallet prompts | 1 signature | 1 signature | 1 signature | 1 signature |
| `/api/log-swap` | POST 200 ok, PATCH 200 ok | same | same | same |
| console warnings and errors | 6 warnings | the same 6 | 6 warnings | the same 6 |
| responses of status 400 or more, page errors | none | none | none | none |
| History row | `649.2567 USDC → 650.0449 USDT CONFIRMED via cowswap ≈ $649.26 0xb4b8b5...e2943a` | identical | same, plus `ETHEREUM` | identical |
| stored row | status from the caller, no gas | `verified_kind` cow, gas 154239 from the receipt | as main v1 | as branch v1 |
| server chain reads for the swap | 8 `eth_call` (pricing the declared amounts at POST) | 8 `eth_call` (pricing the derived amounts at PATCH), `eth_getTransactionByHash` 1, `eth_getTransactionReceipt` 1, `eth_chainId` 1 (once per endpoint) | as v1 | as v1 |

Browser runs, all three:

| Run | Branch build | Result |
|---|---|---|
| 1 | the tree just before 338aa47b's `confirm.ts` change | v1 and v2 pass on main's build and on the branch build |
| 2 | c8398736 | v1 passes; **v2 FAILED** "console warnings and errors as on main": 287 `Failed to load resource: 404` lines on the branch build, 295 on main's (v1: 153 and 153; run 1, v2: 295 and 295) |
| 3 | f48138da | v1 and v2 pass on both builds: no failed load, the same six warnings |

Run 2's cause was in the rig, not in a tree: the rig answered 404 for every token logo, the browser writes one console
error per failed image, and how many logos a token list has asked for when it closes varies from run to run. The rig
now answers a blank image (f48138da) and records every response of status 400 or more; run 3 has none on any of the
four runs, so every one of those lines was a logo. The assertion was not changed: the two console arrays must be equal.
Run 2 was not repeated; run 3 is the changed rig on the same builds.

**Chain reads of one confirmation**: 2 on the row's chain (the transaction, then its receipt), plus one `eth_chainId`
proof per endpoint per process (re-asked after 30 minutes). Pricing is the same helper main's POST called
(`computeTokenAmountUsd`, twice): its reads moved from POST to PATCH and now price the derived amounts. A repeated PATCH
of a verified swap, a PATCH with no row, and a rejected input read nothing. A transaction the node does not have is
asked twice, 1.5 s apart (2 reads; 3 when only the receipt is missing), then answered 202.

**The real CLI**, outside the suite (tsx 4.23.15 already in the npx cache, stub RPC on 127.0.0.1): 3,000 rows into a
pipe read 2 s late gave all 3,008 lines (246,741 bytes), exit 0; real rows gave `mark`, `stored_differs`, `not_found`;
`--apply` with no database exit 1; a bad argument exit 2; not JSON exit 1.

**Mutation proof**: 77 mutants, each one textual change that removes or weakens one rule, applied in a scratch worktree
at f48138da and run against this branch's 11 test files plus `route.test.ts` and `rpc-env.test.ts`. **77 killed, 0
survived, 0 not applied**, every one by failing assertions (none by a compile or run error). The first full run (73
mutants, on 77f65e77) left two survivors, `A6-fc-event-user` and `CR-json-error`, and one mutant that did not
compile (`D-export`); the tests and the mutant were fixed in 338aa47b and all three are killed below. The four
`CR-null-*` / `CR-pause-*` / `CR-last-*` mutants are new with c8398736.

| Mutant | Rule removed or weakened | Tests that fail |
|---|---|---|
| `A3-sender` | A.3 removed: tx.from need not be the wallet | 6 |
| `A4-any-target` | A.4 removed: any target counts as a router | 5 |
| `A4-router-any-source` | A.4 weakened: the router of ANY source of the chain counts | 3 |
| `A4-cow-owner` | A.4 cow: the Trade owner need not be the wallet | 3 |
| `A4-cow-emitter` | A.4 cow: a Trade event from any contract counts | 1 |
| `A4-cow-any-source` | owner 2026-11-25: cow only for cowswap rows, removed | 5 |
| `A4-chain-unaware-fc` | chain-aware removed: the mainnet FeeCollector counts on every chain | 9 |
| `A5-always-confirmed` | A.5 removed: a reverted receipt is confirmed | 5 |
| `A5-unknown-status` | fail closed removed: an unknown receipt status counts as success | 5 |
| `A1-any-source` | A.1 removed: any text is a source | 10 |
| `A1-any-chain` | A.1 removed: the hash is not checked before the read | 5 |
| `A2-rpc-error-is-missing-receipt` | A.2: the two answers need not describe the same transaction | 1 |
| `A6-fc-event-emitter` | A.6: a SwapWithFee event from any contract counts | 1 |
| `A6-fc-event-user` | A.6: a SwapWithFee event of another user counts | 1 |
| `A6-two-candidates` | A.6: two candidates on a side, the first is taken instead of null | 1 |
| `A6-other-wallet-legs` | A.6: another wallet's incoming legs count | 8 |
| `A6-reverted-with-logs` | fail closed removed: a reverted receipt with logs is accepted | 1 |
| `CR-wrong-chain` | the endpoint need not prove its chain | 3 |
| `CR-unverified` | an endpoint whose chain could not be proved is read | 1 |
| `CR-retries` | more than one retry | 21 |
| `CR-json-error` | a JSON-RPC error envelope is an answer | 2 |
| `CR-null-not-retried` | a null answer is final at once (no second asking) | 14 |
| `CR-null-no-pause` | the second asking is sent with no pause | 7 |
| `CR-pause-uncapped` | the environment can lengthen the pause | 1 |
| `CR-last-failure-is-null` | a failure on the last attempt answers null instead of rpc_error | 12 |
| `ENV-next-public` | the server-only resolver takes a NEXT_PUBLIC value | 3 |
| `POST-caller-status` | caller status accepted (POST) | 17 |
| `POST-caller-symbol` | the caller's symbol text is stored | 7 |
| `POST-caller-hash` | a pending row stores the caller hash | 8 |
| `POST-no-cap` | pending cap removed | 5 |
| `POST-cap-off-by-one` | pending cap of 6 | 5 |
| `POST-amount-any` | amounts not validated | 6 |
| `POST-source-any` | source not validated (POST) | 4 |
| `POST-logger-bypass` | POST inserts with the service role | 3 |
| `POST-tracker-usd` | a tracker call at POST carries a caller USD value | 3 |
| `PATCH-other-wallet-lookup` | another wallet's row patched: the pending lookup is not scoped to the wallet | 5 |
| `PATCH-other-wallet-all-layers` | another wallet's row patched: lookup, defence check and update all unscoped | 7 |
| `PATCH-update-unscoped` | the update is not scoped to the wallet | 1 |
| `PATCH-caller-status` | caller status accepted (PATCH) | 3 |
| `PATCH-not-found-confirms` | fail closed removed: not found still writes a hash | 16 |
| `PATCH-dup-precheck` | duplicate hash accepted: the check before the chain read is gone | 2 |
| `PATCH-dup-any-wallet-ok` | duplicate hash accepted: another wallet's verified row answers 200 | 3 |
| `PATCH-dup-index-ignored` | duplicate hash accepted: the unique-index refusal is treated as an ordinary error | 1 |
| `PATCH-window` | the two-hour window is gone | 1 |
| `PATCH-usd-declared` | USD priced from the row instead of the derived amount | 8 |
| `PATCH-fee-flag-kept` | owner 2026-11-25: fee_collected not derived | 3 |
| `PATCH-gas-savings-kept` | owner 2026-11-25: gas_savings_usd not cleared | 4 |
| `PATCH-source-kept` | owner 2026-11-25: the row's source is kept instead of the derived one | 6 |
| `PATCH-trackers-first` | large-trade tracker threshold lowered to zero (fires for every swap) | 3 |
| `PATCH-native-unpriced` | native ETH not priced as the wrapped native | 4 |
| `E-writes-without-columns` | columns missing: POST and PATCH still write | 8 |
| `E-outage-is-missing` | an outage is taken for "columns missing" | 1 |
| `E-no-unique-index` | the migration has no unique index | 3 |
| `E-index-not-partial` | the unique index is not on lower(tx_hash) | 3 |
| `D-flag-default-on` | the flag is on unless it says false | 34 |
| `D-flag-never` | the flag does nothing | 10 |
| `D-stats-count` | flag ignored by one reader: /api/stats total | 1 |
| `D-stats-gasless` | flag ignored by one reader: /api/stats gasless totals | 1 |
| `D-analytics` | flag ignored by one reader: /api/analytics | 1 |
| `D-export` | flag ignored by one reader: /api/analytics/export | 1 |
| `D-personal` | flag ignored by one reader: personal analytics | 2 |
| `D-monitor-global` | flag ignored by one reader: /api/monitor metrics | 1 |
| `D-monitor-wallet` | flag ignored by one reader: /api/monitor wallet lookup | 1 |
| `D-health-count` | flag ignored by one reader: /api/health count | 1 |
| `D-health-sample` | flag ignored by one reader: /api/health sample | 1 |
| `D-surplus` | flag ignored by one reader: the surplus report | 1 |
| `D-history-filtered` | the wallet's own history hides unverified rows when the flag is on | 2 |
| `F-apply-differs` | --apply marks rows whose stored values differ | 6 |
| `F-amount-in-ignored` | stored amount-in not compared | 3 |
| `F-token-ignored` | stored token-out not compared | 3 |
| `F-out-bound-low` | amount-out lower bound removed | 2 |
| `F-out-bound-high` | amount-out upper bound removed | 1 |
| `F-status-ignored` | stored status not compared | 1 |
| `F-apply-extra-columns` | --apply writes more than the two columns | 1 |
| `F-apply-in-report` | report mode writes | 2 |
| `F-error-text` | the script prints an unexpected error text | 1 |
| `F-db-error-text` | the script prints the database error message | 1 |

## 6. Verify runs, SHAs, diff, what was NOT verified

Verify runs: one. `scripts/agent-verify.sh --codeql`, 2026-11-25 12:16 to 12:21, 1-minute load 1.5 at the start, no
other verify, CodeQL, build or test process running, on the last code commit. No run was started before it and none
after. A `brew` stand-in that only exits 1 was first on PATH (this goal forbids brew; the script calls it only for
`--keeper`, which was not requested). Logs: `~/ts-worktrees/swap-log-verified-on-chain.verify/run1/`.

```
=== EVIDENCE ===
branch: fix/swap-log-verified-on-chain @ bbe9d40e (base origin/main @ 5b526e7d)
suite:       PASS 11954 tests passed, 0 failed, 560 files
lint-delta:  PASS errors +0, warnings +0 (40 changed files; head 0 err/0 warn, base 0 err/0 warn)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 11, base 11, new by rule+file+message 0 (pack 2.5.0, CLI 2.27.5)
keeper:      SKIP not requested (--keeper)
diff --stat origin/main...HEAD: 62 files changed, 10695 insertions(+), 266 deletions(-)
compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/swap-log-verified-on-chain
RESULT: PASS
=== END EVIDENCE ===
```

SHAs: the verified commit is `bbe9d40ef1315e7331023ce1509d4425f9d7a2e9`; the docs head is the commit that adds the two
feedback files on top of it (its hash is in the hand-off message: a file cannot hold its own commit's hash).

Commits, oldest first: 588324fb (A), 3570c127 (B), daa02a56 (C), a72e0a09 (E), 8621062b (D), 6aa0cddf (F), 77f65e77
(replay, property), 338aa47b (browser rig, two tests for surviving mutants), c8398736 (a null read is asked once more),
f48138da (rig: blank image for logos), bbe9d40e (merge of origin/main). All SSH-signed.

origin/main moved from 5465ceb0 to 5b526e7d while the branch was being built (PR #728: the pinned CodeQL pack of the
verify script; no file under `src/`). It was merged into the branch, which had not been pushed, so the one verify ran
with the current tooling and against the current main. What was measured on 5465ceb0 (the golden, the replay "before",
the browser baseline) is main's application code, which PR #728 does not touch. The mutation run and browser run 3 ran
on f48138da, whose `src/`, `scripts/swaps/`, `supabase/` and `e2e/` trees are identical to bbe9d40e's.

Other checks run outside the verify: gitleaks over the branch's commits (no leaks, before the merge); the real CLI on
the final tree; the incident replay on main and on the final tree.

Not verified:
- The migration text was not run against any database (none may be touched; no local Postgres is installed). Its
  statements are checked as text (`fake-swaps-db.schema.test.ts`) and its effect is modelled by the fake database.
- No production host, database or keyed RPC was called. Real receipts were read from public nodes only.
- No real wallet. The browser run drives the CoW flow on Ethereum with a wallet stub that holds no key; a FeeCollector
  swap and a 0x swap were not driven in the browser (they are covered at the route with real receipts), nor Base and
  Arbitrum in the browser, nor a WalletConnect or smart-contract wallet.
- CI (Linux, Node 22) has not run: it starts when the owner opens the PR. Local runs are on macOS, Node 26.13.1.
- The script was not run against the stored table; `--from-db` and `--apply` ran on the fake database only.
- The flag was never on in a deployed environment; flag-on behaviour is proved by the differential only.
- A reorg after a receipt was read, a provider that answers `null` for an existing transaction (seen on public nodes
  during the sampling; a lag shorter than the 1.5 s retry is now covered, a longer one leaves the row pending, 202)
  and rate-limited providers were not exercised beyond the stubs.
- Playwright 1.65.1 expects Chromium build 1255, which is not installed; the run used the installed build 1248
  (`PW_CHROMIUM`). Nothing was installed.

## 7. Notes that did not fit the one screen

Owner steps, in order: (1) apply `supabase/migrations/20261125120000_swaps_verified.sql`; (2) deploy; the flag stays
off; (3) `npx --yes tsx --tsconfig tsconfig.json scripts/swaps/verify-stored-swaps.ts --from-db > report.ndjson` with
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RPC_URL_1`, `RPC_URL_8453`, `RPC_URL_42161`,
`NEXT_PUBLIC_BASE_FEE_COLLECTOR` and `NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR` set; read it; (4) the same with `--apply`;
(5) set `SWAPS_PUBLIC_VERIFIED_ONLY=true`. Turning the flag on before step 1 makes the public readers error (a filter on
a column that does not exist).

Rig and test notes:
- No expectation of a test that exists on main was changed. `src/app/api/log-swap/route.test.ts`: its Supabase mock
  answers the two reads POST now makes before the insert; its eight assertions are as they were. No test was skipped,
  rerun or given a wait.
- TWO EXPECTATIONS OF TESTS THIS BRANCH ITSELF ADDED WERE CHANGED, in c8398736, with the behaviour they describe:
  (1) `chain-read.test.ts` "A NULL RESULT IS RETURNED AS IT IS AND IS NOT RETRIED" (1 READ) IS NOW "NULL TWICE: NULL IS
  THE ANSWER, AFTER EXACTLY TWO READS"; (2) `route.patch.test.ts` "THE HASH IS MATCHED ... ON THE ROW'S CHAIN ONLY"
  EXPECTS THE BASE READ TWICE, IT EXPECTED IT ONCE. Why: the browser sends its confirmation once, right after it saw
  the receipt, and a pending row has no hash to find it by later; a provider node one block behind answers null, and
  the swap would have stayed pending in History for ever, where main marked it at once. Details A.2 allows one retry;
  it is now also used for a null, after 1.5 s. Three other chain-read tests answered null only as a filler and now
  answer an object; their expectations are as they were.
- New optional variable `SWAP_VERIFY_MISSING_RETRY_MS`: it can shorten that pause (the tests and the stored-rows
  script set 0) and can never lengthen it (`chain-read.ts:29-33`). Nothing needs to set it.
- The property test first failed on `expected_output` (a caller's digits on a verified row). That column and `slippage`
  are kept by owner answer 2; the property now says so and checks every other column.
- The browser stub keeps the CoW order open for 8 s. With an instantly settled stub, main's own PATCH overtakes its
  POST (main's POST prices the declared amounts first) and main's row stays pending: an artefact of a stub that settles
  faster than any solver, not a behaviour of this change.
- Mutation run 1 left two survivors, both pinned since: a `SwapWithFee` event naming another user (unreachable on-chain,
  where the event's user is the caller), and a JSON-RPC answer that carries an error beside a result. One mutant of
  run 1 did not compile (a syntax error in the mutant, not a kill); it was rewritten and is killed by the differential.
- CodeQL patterns avoided before the run, from earlier branches' alerts: no caller-influenced comparison stands in
  front of the call to `verifySwapOnChain` (the second wallet check moved into the row choice); the test doubles use a
  Map and `Object.fromEntries` where a name can come from a request.

The two mev fields: `mev_savings_actual` was read by the weekly surplus report only (`src/lib/surplus-report.ts:80`,
sent to the ops Telegram channel); `mev_savings_estimate` was read by nothing. A verified row has both null until
phase 2. The "MEV savings" line of the success toast is computed in the browser and does not read them.
`/api/monitor/validate-execution` (bearer-authenticated) still writes `mev_savings_actual` by transaction hash; a
verification that comes after it clears the value.

Further concerns:
- A caller that names a wallet with a pending row and an invented hash costs the server two chain reads and holds the
  request for 1.5 s; the only bound is the shared 120 per minute per-IP budget of the log routes.
- One retry narrows the lagging-node case, it does not close it: a node more than 1.5 s behind still leaves the row
  pending (202), and the official client does not ask again. Phase 2 could let the client repeat a 202.
- "Total Gas Saved" (`/api/stats`) stops growing for newly verified swaps (owner answer 2).
- `/api/history` returns `select *`, so `verified_at` and `verified_kind` are in its answer once the columns exist.
- A POST whose amount is not decimal digits (a malformed quote from an adapter) is a 400; main stored the text.
- The wallet-activity line written at POST carries the validated source, catalog symbols, slippage and the two flags
  (no USD, no hash): that table is the debugging log the browser also writes to through `/api/log-activity`.
- docs/security/AUDIT-TOTAL.md was not edited: the ledger is the Auditor's.

---

# Round 2 (goal 133b: audit A103 at 09ddf974, blocked 0C/4H; ADR-029 section 7)

Line numbers are of the last code commit. "09ddf974" is the audited head (its code is bbe9d40e's).

## R1. Per finding: where it is fixed, the test, and the failing-first proof

Failing-first: the new test files of fb0ff58b were copied into a detached worktree at 09ddf974
(`~/ts-worktrees/swap-log-r2-old`), with the branch's test utilities and fixtures and 09ddf974's own fake database (its
unique index (chain, hash)), and run there. Logs: `~/ts-worktrees/swap-log-r2.rig/failing-first/`. 43 new tests: **34
fail on 09ddf974, 9 pass**; the 9 are controls of behaviour 09ddf974 already had right (named in the last column). The
guard file needs the branch's `private-columns.ts` to load; with it, its six `/api/history` cases fail on 09ddf974 and
its other 19 pass (those readers never returned a claim). The four tests 2684ff30 added later were written to kill
surviving mutants (R4); they are not in that count.

| Finding | Fixed at | Tests (new) | On 09ddf974 |
|---|---|---|---|
| S-1 net flows | `src/lib/swap-verify/verify-swap-on-chain.ts:298` (netTokenFlows), `:323-339` (routerSides; `:337` ETH in needs a token out, owner 2026-11-26) | `route.a103.test.ts` "S-1" (1, 2, 50 loops; control swap; wrap / unwrap / refund; "no alert"), `verify-swap-on-chain.a103.test.ts` "S-1" and the seeded property | fail: 1/2/50 loops (route and verify), wrap/unwrap/refund, no-alert, property seeds 133 and 20261126. Pass: the real swap (control) |
| S-2 event, not target | `:547-561` (exactly one SwapWithFee emitted by that chain's FeeCollector for the wallet; none and tx.to is the FeeCollector: `no_swap_event`), `:526-543` (reverted: only from the wallet to the FeeCollector or a listed router) | "S-2": the getter on Ethereum, Base and Arbitrum (fork receipts), approve, revert inside a successful call, a reverted FeeCollector swap, two events for one wallet | fail: the three getters (route and verify), two events. Pass: approve, revert inside, reverted (09ddf974 already rejected or failed those) |
| S-3 the transaction makes the row | `src/lib/swap-log/confirm.ts:242` (chooseRow: same chain, same in token, newest; else a new row), `:298` (confirmSwap); `src/lib/swap-log/store.ts:328` (makeRoomForPending, J); `src/app/api/log-swap/route.ts:94` | "S-3": the audit's path (5 rows planted on Arbitrum / 0x), 5 abandoned own attempts, a CoW order settling under a newer pending row | fail: all three |
| S-4 a claim is kept | `confirm.ts:265` (keepClaim), `store.ts:245`, `:267`, `:351`; `src/lib/analytics.ts:115`, `:134` (2, 8, 30 s); `scripts/swaps/verify-stored-swaps-lib.ts:194`, `:280` | "S-4": receipt null twice, node 503, chain-id probe failing, no chain named; `analytics.update-swap-status.test.ts`; the script's claim tests; browser lag mode (R4) | fail: all four route cases; client 4 of 5 (the 5th, "a caller that knows no chain still sends", passes on both) |
| S-5 smart wallets | `verify-swap-on-chain.ts:547-559` (the event's user; tx.from and tx.to not read) | "S-5": a Coinbase Smart Wallet swap, bundler -> EntryPoint (fork receipt) | fail (route and verify) |
| S-6 once per wallet | `supabase/migrations/20261125120000_swaps_verified.sql:101`, `supabase/schema.sql:244`; `store.ts:136` (the code check per wallet) | "S-6": in sequence, at once, a third party | fail: all three |
| S-8 Base router | `verify-swap-on-chain.ts:162` (routersOn: that chain's whitelist) | "S-8": the real Base swap 0xfb357206 straight to SwapRouter02 | pass on both, as expected (09ddf974 was right, it had no test): the mutant `S8-router-chain-1` is killed (R4) |

## R2. What a request costs, and the retire rule's edge cases

Chain reads (each read: one attempt and one retry at most, 4 s each, 1.5 s before a `null` is asked again):

| Request | Reads, worst case | Bounded by |
|---|---|---|
| PATCH naming its chain (the official client, every call site) | 1 chain-id proof (once per endpoint per process) + transaction 2 + receipt 2 = **5** | 4 + 9.5 + 9.5 s, then pricing |
| PATCH naming no chain (an old client, a third party) | 3 proofs + transaction 2 on each of 3 chains + receipt 2 = **11** | no new chain after 20 s (`confirm.ts:63`); maxDuration 60 (`route.ts:21`) |
| PATCH already verified for this wallet | 0 | one lookup |
| POST without a hash | 0 | |
| POST with a hash (split-swap leg) | as PATCH naming its chain | |
| script, a claim with no chain | as PATCH naming no chain | `--delay-ms` between rows |

Pricing is unchanged (two `computeTokenAmountUsd` after a verification). The rpc-budget check is the browser's
budget; no browser call was added (the client's retries go to our own `/api/log-swap`).

Details J, as the owner answered (2026-11-26), and what the tests pin (`route.post.test.ts` "pending rows are scratch"):

| Case | What happens |
|---|---|
| fewer than 5 pending rows of the wallet in the last hour | the new row is written; nothing retired |
| 5 in the last hour, one without a claim | the oldest scratch row without a claim is deleted, then the new row is written (6th POST answers 200, never 429) |
| 5 in the last hour, all carry a claim younger than 24 h | a 6th row is written, none deleted |
| all carry a claim, one older than 24 h | that row is deleted |
| 20 scratch rows (last hour, or carrying a claim of any age) | the oldest goes, whatever it carries; the wallet stays at 20 |
| a row older than an hour without a claim (a row written before this change among them) | never deleted |
| a confirmed, verified, or hash-carrying row; another wallet's row | never deleted (the DELETE repeats wallet, status pending, tx_hash null, verified_at null) |
| a claim row (a PATCH found no pending row to hold its hash) | counts as scratch, goes through the same rule before it is written |
| the scratch rows can not be read | the new row is written anyway; one fixed log line |

Residue: count-then-delete-then-insert is not atomic, so two POSTs at the same moment can leave 21 rows for an instant;
a third party that sends more than 20 invented hashes for a wallet after the wallet's own client has stopped asking
(40 s) can push the wallet's real claim out (the script then has nothing to pick up). In the first hour after the
deploy, a pending row written by main's POST in that hour is scratch too.

## R3. Wraps, unwraps, and what real receipts did

Fork receipts (Base, Uniswap SwapRouter02, `FORK_RECEIPTS`): a **wrap alone** (0.5 ETH value, wrapETH, sweep WETH to the
wallet) is a confirmed router swap ETH 0.5 -> WETH 0.5; an **unwrap alone** (pull 0.5 WETH, unwrapWETH9 to the wallet) is
WETH 0.5 -> null (ETH arriving leaves no log). Both are counted at their real outflow, once per transaction (ADR-029
7.6 residue). **1 ETH sent and refunded** (refundETH, no token moves): rejected `no_net_swap` (owner, 2026-11-26).

The round-2 verification over every claim of round 1's 432 real cached transactions (434 files, two without a
transaction; copied to `~/ts-worktrees/swap-log-r2.rig/real-cache/`, result `real-claims-r2.json`): 390 confirmed,
4 failed, 41 rejected, 0 ambiguous.

| Chain | Kind | Confirmed, both sides | Confirmed, in side only | Failed | Rejected |
|---|---|---|---|---|---|
| Ethereum | fee_collector V2 / V1 | 34 / 7 | 0 / 4 | 0 / 2 | 0 |
| Base / Arbitrum | fee_collector | 12 / 2 | 0 | 0 | 0 |
| Ethereum / Base / Arbitrum | cow | 16 / 12 / 15 | 0 | 0 | 0 |
| Ethereum | router (0x) | 185 | 64 | 2 | 38 |
| Base | router (0x) | 18 | 7 | 0 | 0 |
| Arbitrum | router (0x) | 9 | 5 | 0 | 3 |

The 41 rejected are the one case of the new rules met in real receipts: 0x transactions where the sender paid ETH and
the bought token went to ANOTHER address (the sender received no token: 0 Transfer legs of the wallet). Round 1 counted
them at the ETH value; the ETH-in rule now rejects them. They were sampled from all 0x traffic, not from TeraSwap
users: the official client always sets the user as the recipient, so its ETH -> token swaps carry the bought token's
Transfer to the wallet. No real receipt had two SwapWithFee events or two CoW Trades for one wallet: the `ambiguous`
reason is reached only by the tests' built receipts. How the official client could make two SwapWithFee events in one
transaction: `useSplitSwap` sends each leg as its own transaction (`useSplitSwap.ts:599`), so only a smart wallet whose
bundler put two of its legs into one `handleOps` could; ERC-4337 bundlers do not bundle two operations of one unstaked
sender, so it was not seen.

## R4. Differential, property seeds, mutation proof, browser steps

**Round 1 holds** (unchanged files, all green): the flag-off differential of the nine readers against the main golden
(`swaps-readers.differential.test.ts`, bodies AND queries byte-identical; `/api/history` drops the three claim columns,
which main's rows do not have), the incident replay (9 shapes, the victim's PUBLIC columns), the pre-migration
behaviour (`route.unmigrated.test.ts`, the probe now asks for the five columns).

**Property seeds**: `route.property.test.ts` 133 and 20261125 (1,000 requests each, P1 to P7 with J's P7);
`verify-swap-on-chain.a103.test.ts` 133 and 20261126 (2,000 random Transfer-leg receipts each: a confirmed router swap's
in amount never exceeds the wallet's net outflow, its out amount never its net inflow).

**Mutation proof** (`~/ts-worktrees/swap-log-r2.rig/mutants-r2.mjs`, in the scratch worktree `swap-log-mut`, never the
branch's): 53 mutants, each one textual change that removes or weakens one rule, run against the 18 test files of the
swap log (402 tests). Run 1 at fb0ff58b: 48 killed, 4 survived, 1 not applied (its find text also matched a comment
line). The four survivors were real gaps; each got a test in 2684ff30 (H.3 same asset on both sides, a built receipt;
H.4 a reverted call to an unrelated contract; I.2 a reverted call goes to the row with its source; I.2 a row holding
another claim is skipped), the harness's find text was fixed, and run 2 at 2684ff30 killed all five. **53 of 53 killed,
every one by failing assertions**; the six of details M are the first six rows, S-8's mutant the eighth.

| Mutant | Rule removed or weakened | Result |
|---|---|---|
| `M-netting-removed` | netting removed: a token's inflow is not set against its outflow | killed: 23 failed in scripts/swaps/verify-stored-swaps.test.ts, swap-verify/verify-swap-on-chain.a103.test.ts, swap-verify/verify-swap-on-chain.test.ts, log-swap/route.a103.test.ts |
| `M-event-address-removed` | a SwapWithFee event of any contract counts (the emitter check removed) | killed: 3 failed in swap-verify/verify-swap-on-chain.test.ts |
| `M-user-check-removed` | a SwapWithFee event of another user counts | killed: 11 failed in scripts/swaps/verify-stored-swaps.test.ts, swap-verify/verify-swap-on-chain.a103.test.ts, swap-verify/verify-swap-on-chain.test.ts, log-swap/route.a103.test.ts |
| `M-row-newest-only` | the row is the newest pending row of the wallet, whatever its chain and token | killed: 6 failed in log-swap/route.a103.test.ts, log-swap/route.patch.test.ts, log-swap/route.property.test.ts |
| `M-claim-not-stored` | a hash the chain could not answer is not kept | killed: 14 failed in swap-log/confirm.test.ts, log-swap/route.a103.test.ts, log-swap/route.incident-replay.test.ts, log-swap/route.patch.test.ts |
| `M-unique-without-wallet` | the wallet dropped from the unique key (migration, schema mirror and the database model) | run 1: NOT APPLIED; run 2: killed: 6 failed in test-utils/fake-swaps-db.schema.test.ts, log-swap/route.a103.test.ts, log-swap/route.patch.test.ts |
| `M-unique-check-across-wallets` | the code check of one transaction looks across wallets | killed: 6 failed in log-swap/route.a103.test.ts, log-swap/route.patch.test.ts |
| `S8-router-chain-1` | a router is looked up on chain 1 for every chain | killed: 17 failed in swap-verify/verify-swap-on-chain.a103.test.ts, swap-verify/verify-swap-on-chain.test.ts, log-swap/route.a103.test.ts, log-swap/route.patch.test.ts |
| `H1-fc-by-target` | a call to the FeeCollector with no event is a swap (the round-1 rule) | killed: 17 failed in scripts/swaps/verify-stored-swaps.test.ts, swap-verify/verify-swap-on-chain.a103.test.ts, swap-verify/verify-swap-on-chain.test.ts, log-swap/route.a103.test.ts |
| `H1-ambiguous-first` | two SwapWithFee events of the wallet: the first is taken | killed: 1 failed in swap-verify/verify-swap-on-chain.a103.test.ts |
| `H1-chain-unaware-fc` | the mainnet FeeCollector counts on every chain | killed: 20 failed in scripts/swaps/verify-stored-swaps.test.ts, swap-verify/verify-swap-on-chain.a103.test.ts, swap-verify/verify-swap-on-chain.test.ts, swap-log/confirm.test.ts |
| `H2-cow-emitter` | a Trade event of any contract counts | killed: 1 failed in swap-verify/verify-swap-on-chain.test.ts |
| `H2-cow-owner` | a Trade of another owner counts | killed: 8 failed in swap-verify/verify-swap-on-chain.test.ts, log-swap/route.a103.test.ts, log-swap/route.patch.test.ts, log-swap/route.property.test.ts |
| `H2-cow-ambiguous-first` | two Trades of the wallet: the first is taken | killed: 1 failed in swap-verify/verify-swap-on-chain.test.ts |
| `H3-router-sender` | a router swap need not be sent by the wallet | killed: 1 failed in swap-verify/verify-swap-on-chain.test.ts |
| `H3-any-target` | any target counts as a router | killed: 5 failed in swap-verify/verify-swap-on-chain.test.ts |
| `H3-eth-in-no-out` | owner 2026-11-26 removed: ETH in with no out side is a swap | killed: 4 failed in swap-verify/verify-swap-on-chain.a103.test.ts, log-swap/route.a103.test.ts |
| `H3-two-candidates-first` | two candidates on a side: the first is taken | killed: 3 failed in swap-verify/verify-swap-on-chain.a103.test.ts, swap-verify/verify-swap-on-chain.test.ts |
| `H3-same-token-both-sides` | the same token on both sides is accepted | run 1: SURVIVED; run 2: killed: 1 failed in swap-verify/verify-swap-on-chain.a103.test.ts |
| `H4-reverted-any-sender` | a reverted transaction of another sender is this wallet's failed swap | killed: 1 failed in swap-verify/verify-swap-on-chain.test.ts |
| `H4-reverted-any-target` | a reverted transaction to any contract is a failed swap | run 1: SURVIVED; run 2: killed: 1 failed in swap-verify/verify-swap-on-chain.a103.test.ts |
| `H-unknown-status` | fail closed removed: an unknown receipt status counts as success | killed: 5 failed in swap-verify/verify-swap-on-chain.test.ts, log-swap/route.patch.test.ts |
| `I2-agree-any-chain` | a pending row of another chain is attached to | killed: 2 failed in log-swap/route.patch.test.ts |
| `I2-agree-any-token` | a pending row of another in token is attached to | killed: 3 failed in log-swap/route.a103.test.ts, log-swap/route.patch.test.ts |
| `I2-failed-any-source` | owner 2026-11-26 removed: a reverted call naming no token attaches to any row of the chain | run 1: SURVIVED; run 2: killed: 1 failed in log-swap/route.patch.test.ts |
| `I2-attach-over-other-claim` | a row holding another transaction's claim is attached to | run 1: SURVIVED; run 2: killed: 1 failed in log-swap/route.patch.test.ts |
| `I2-no-insert` | no agreeing row: nothing is written (the round-1 "no row") | killed: 8 failed in log-swap/route.a103.test.ts, log-swap/route.patch.test.ts, log-swap/route.property.test.ts |
| `I4-claim-overwrite` | a claim overwrites another claim | killed: 2 failed in log-swap/route.incident-replay.test.ts, log-swap/route.patch.test.ts |
| `I6-claim-not-cleared` | a decided claim is not cleared (rejected, or held by another row) | killed: 1 failed in scripts/swaps/verify-stored-swaps.test.ts |
| `I-chainless-pending-only` | H.5 as written (owner 2026-11-26 removed): no chain named and pending rows exist: only their chains | killed: 3 failed in scripts/swaps/verify-stored-swaps.test.ts, swap-log/confirm.test.ts, log-swap/route.patch.test.ts |
| `I-no-search-budget` | a search that names no chain has no time budget | killed: 1 failed in swap-log/confirm.test.ts |
| `I1-chain-ignored` | the chain the client names is ignored | killed: 4 failed in log-swap/route.a103.test.ts, log-swap/route.patch.test.ts |
| `I5-client-no-retry` | the client does not ask again on 202 | killed: 3 failed in analytics.update-swap-status.test.ts |
| `I5-client-retry-any` | the client asks again whatever the answer | killed: 2 failed in analytics.update-swap-status.test.ts |
| `I1-client-no-chain` | the client does not send the chain | killed: 1 failed in analytics.update-swap-status.test.ts |
| `J-no-retire` | the cap retires nothing (rows pile up) | killed: 5 failed in log-swap/route.incident-replay.test.ts, log-swap/route.post.test.ts |
| `J-retire-old-rows` | rows older than the hour without a claim can be retired | killed: 2 failed in log-swap/route.post.test.ts |
| `J-claimed-not-protected` | the oldest scratch row goes first, claim or not | killed: 1 failed in log-swap/route.post.test.ts |
| `J-24h-ignored` | a claim of any age is retired when all carry one | killed: 1 failed in log-swap/route.post.test.ts |
| `J-no-total-cap` | no total of 20 | killed: 2 failed in log-swap/route.post.test.ts, log-swap/route.property.test.ts |
| `J-delete-unscoped` | the delete does not name the wallet | killed: 2 failed in log-swap/route.post.test.ts |
| `J-cap-off-by-one` | the cap triggers at 6 | killed: 5 failed in log-swap/route.incident-replay.test.ts, log-swap/route.post.test.ts |
| `K-claim-column-missing` | the migration has no claimed_at | killed: 3 failed in test-utils/fake-swaps-db.schema.test.ts |
| `G-history-not-stripped` | /api/history returns the claim columns | killed: 11 failed in swaps-read-claim-columns.guard.test.ts, swaps-readers.differential.test.ts |
| `K-probe-two-columns` | the "migration applied" probe asks for the two round-1 columns only | killed: 1 failed in log-swap/route.unmigrated.test.ts |
| `L-claims-ignored` | the script does not look at claims | killed: 1 failed in scripts/swaps/verify-stored-swaps.test.ts |
| `L-caller-columns-missing` | the report does not list the caller columns | killed: 2 failed in scripts/swaps/verify-stored-swaps.test.ts |
| `L-apply-extra-columns` | --apply writes more than the two columns on an old row | killed: 2 failed in scripts/swaps/verify-stored-swaps.test.ts |
| `R1-post-caller-hash` | a pending row stores the caller hash | killed: 10 failed in log-swap/route.incident-replay.test.ts, log-swap/route.patch.test.ts, log-swap/route.post.test.ts, log-swap/route.property.test.ts |
| `R1-update-unscoped` | the verification update does not name the wallet | killed: 2 failed in log-swap/route.patch.test.ts |
| `R1-flag-default-on` | the flag is on unless it says false | killed: 34 failed in swaps-readers.differential.test.ts, swap-log/public-filter.test.ts |
| `R1-writes-without-columns` | columns missing: POST and PATCH still write | killed: 6 failed in log-swap/route.unmigrated.test.ts |
| `R1-null-not-retried` | a null answer is final at once | killed: 14 failed in swap-verify/chain-read.test.ts, log-swap/route.patch.test.ts |

**Browser** (`e2e/swap-log/swap-to-history.pw.ts`, `~/ts-worktrees/swap-log-r2.rig/e2e-run.sh`; Chromium headless shell
1248, production builds, real CSP, real `/api/log-swap` and `/api/history` on the local PostgREST shim, the server's
chain reads on a local node serving the recorded CoW settlement). Main's build: 5465ceb0 (main's application code is
unchanged since, to 623f58fd). Branch build: 34f84217 (the application code of the last code commit; later commits
change tests, the rig and the workflow file only). Steps as round 1: the stub wallet reconnects, flip the pair, choose
USDT, type 649.256721, swap, review, confirm, the order settles after 8 s, open History. Lag mode: the node answers
`null` to the first 2 receipt reads.

| | main v1 | branch v1 | main v2 | branch v2 |
|---|---|---|---|---|
| normal: prompts | 1 signature | same | same | same |
| normal: `/api/log-swap` | POST 200, PATCH 200 | same | same | same |
| normal: History row | `649.2567 USDC → 650.0449 USDT CONFIRMED via cowswap ≈ $649.26 0xb4b8b5...e2943a` | identical | same, plus `ETHEREUM` | identical |
| lag: `/api/log-swap` | POST 200, PATCH 200 | POST 200, PATCH **202**, PATCH 200 (2 s later) | as v1 | as v1 |
| lag: History row, prompts, console | as normal | identical to main | as normal | identical to main |
| lag: server chain reads | 8 `eth_call` | + tx 2, receipt 3 (null, null, then the receipt), 1 chain-id proof | as v1 | as v1 |
| stored row | caller's status, no gas | `cow`, gas 154239, claim cleared | as v1 | as v1 |
| console (5 lines) and failed loads | the same in all 8 runs; no page error, no response of 400 or more | | | |

| Run | Result |
|---|---|
| 1 (18:36) | 7 of 8 pass; **branch v1 lag FAILED** "console warnings and errors as on main": the same 6 lines in another order. The moving line is Playwright's own "Service Worker registration blocked by Playwright" (from the rig's `serviceWorkers: 'block'`); main's build alone put it first in one run and fifth in the next. |
| 2 (18:41) | rig changed (that one harness line is counted apart and compared with main as a count; the ordered console comparison unchanged): **8 of 8 pass**. Run 1 was not repeated as it was; logs `~/ts-worktrees/swap-log-r2.rig/browser-run1/`. |

## R5. Verify runs, SHAs, diff, what was NOT verified

Two runs of `scripts/agent-verify.sh --codeql`, each started by `~/ts-worktrees/swap-log-r2.rig/verify-waiter.sh` only
after the 1-minute load stayed under 10 on two checks 30 s apart with no other agent-verify or CodeQL process (the
machine was shared with other sessions and Spotlight; the waiter held run 1 for about 25 minutes). A `brew` stand-in
that only exits 1 was first on PATH (the script calls brew only for `--keeper`, not requested). Node 26.13.1, macOS.
Logs: `~/ts-worktrees/swap-log-verified-on-chain.verify/r2-run1/` and `r2-run2/`. No other verify run was started.

| Run | Commit | Start (1-min load) | Result |
|---|---|---|---|
| 1 | 2684ff30 | 19:16:58 (5.84) | **FAIL**: codeql head 12, base 11, **1 new**: `js/identity-replacement` at `src/app/api/log-swap/route.patch.test.ts:535`, "This replaces '0x' with itself" (a no-op `.replace(/^0x/, '0x')` in the 409 test this round added). Every other check PASS (suite 12054 / 571 files, lint-delta +0/+0, tsc, build, parity 123, rpc-budget 36). |
| 2 | cbd51bcf (the fix: the mixed-case wallet built as "0x" + the upper-cased hex digits; no assertion changed) | 19:28:17 (4.12) | **PASS**, block below |

```
=== EVIDENCE ===
branch: fix/swap-log-verified-on-chain @ cbd51bcf (base origin/main @ 623f58fd)
suite:       PASS 12054 tests passed, 0 failed, 571 files
lint-delta:  PASS errors +0, warnings +0 (51 changed files; head 0 err/22 warn, base 0 err/22 warn)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 11, base 11, new by rule+file+message 0 (pack 2.5.0, CLI 2.27.5)
keeper:      SKIP not requested (--keeper)
diff --stat origin/main...HEAD: 89 files changed, 16080 insertions(+), 287 deletions(-)
compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/swap-log-verified-on-chain
RESULT: PASS
=== END EVIDENCE ===
```

SHAs: the last code commit (verified) is `cbd51bcff74fc85eef4ea67d957e1d1b47a2809a`; the docs head is the commit that adds
this text (named in the hand-off message: a file cannot hold its own commit's hash). Round-2 commits, oldest first, all
SSH-signed: 64475599 (merge of origin/main, PR #727), 15dcbc37 (H), 4dc2260a (K), fbfb89d2 (I), a11c2faa (J), 34f84217
(L), fb0ff58b (M), c4ce9030 (merge of origin/main, PR #730), 2684ff30 (tests for the four survivors), cbd51bcf (the
CodeQL fix).

Diff since 09ddf974, at cbd51bcf: this round's own code (from 64475599, without the workflow file and docs) 49 files
+5644 / -691, of which 34 files +2878 / -691 without the receipt fixtures; everything since 09ddf974, main's PRs #727 and
#730 included: 73 files +6753 / -813. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/swap-log-verified-on-chain

Other checks outside the verify: the full suite once before it (571 files, 12,054 tests, 0 failed, on 2684ff30's
tree); gitleaks over the round's commits (no leaks); `gen-claude-state --check` (current); the failing-first runs, the
mutation runs, the browser runs and the real-receipt tally above.

NOT verified:
- The migration against any database (none may be touched; no local Postgres): checked as text and modelled by the
  fake database, including the new per-wallet index and the claim columns.
- CI (Linux, Node 22): it starts when the owner opens the PR. Local runs: macOS, Node 26.13.1.
- A real wallet, WalletConnect, a real bundler: the smart-wallet swap is a Coinbase Smart Wallet user operation sent
  through the real EntryPoint v0.6 on a LOCAL fork of Base, not on Base.
- FeeCollector and 0x swaps in the browser, and Base / Arbitrum in the browser: the browser drives the CoW flow on
  Ethereum; the rest is covered at the route with real and fork receipts.
- The script against the stored table (`--from-db` and `--apply` ran on the fake database only).
- The flag on in a deployment (flag-on behaviour: the differential only).
- The FeeCollector "sweep the input back" concern of R7 was not probed on a fork.
- No production host, database or keyed RPC was called.

## R6. Changed expectations, in capitals (all in tests this branch added in round 1; no test on main changed)

Each is marked `CHANGED (133b …)` at the line in the test, with what it was: 43 changed expectations (45 marks; two are
file headers) in 8 files, every one added by this branch in round 1. `src/app/api/log-swap/route.test.ts` (on main) had
only its hand-made Supabase mock taught the new reads; none of its eight assertions changed.

- VERIFY-SWAP-ON-CHAIN.TEST.TS (13): 19 REAL FIXTURES, WAS 18 (S-8 ADDED). THE FIVE "BAD_SOURCE" INPUT CASES ARE GONE
  WITH THE SOURCE INPUT (H), REPLACED BY "JUNK HINTS CHANGE NOTHING". ANOTHER WALLET ON A FEECOLLECTOR SWAP: NO_SWAP_EVENT
  AFTER 2 READS, WAS WRONG_SENDER AFTER 1. A SWAPWITHFEE OF ANOTHER USER, OR ONE NOT EMITTED BY THE FEECOLLECTOR:
  REJECTED NO_SWAP_EVENT, WAS CONFIRMED WITH NULL SIDES. ETH PAID AND USDT SENT: IN = USDT, WAS BOTH SIDES NULL. THE SAME
  0X SWAP UNDER ANOTHER SOURCE: CONFIRMED AS 0X, WAS WRONG_TARGET. A SECOND INCOMING TOKEN: NO_NET_SWAP, WAS CONFIRMED
  WITH THE OUT SIDE NULL. COW VIA A SOLVER'S CONTRACT, STRANGER: WRONG_TARGET, WAS COW_NO_TRADE_FOR_WALLET. COW UNDER
  ANOTHER SOURCE: CONFIRMED, WAS WRONG_TARGET. A 0X SWAP WHOSE ROW SAID COWSWAP: CONFIRMED ROUTER, WAS REJECTED. TWO
  IDENTICAL TRADES: AMBIGUOUS, WAS SUMMED. A CONTRACT CREATION: DECIDED AFTER 2 READS, WAS 1.
- ROUTE.PATCH.TEST.TS (14): A CALLER NAMING ITS OWN WALLET AND THE VICTIM'S TRANSACTION: 422, WAS 200 WITH NO READ.
  INVENTED HASHES FOR THE VICTIM: CLAIMS KEPT PRIVATELY, WAS "NO WRITE". THE REASON NO_SWAP_EVENT, WAS WRONG_SENDER. A
  PENDING ROW OF ANOTHER TOKEN IS NOT ATTACHED TO (A NEW ROW IS MADE), WAS CONFIRMED WITH THE TRANSACTION'S VALUES. A
  ROW OLDER THAN 2 H, A FAILED ROW, A ROW WITH ANOTHER HASH: THE SWAP IS RECORDED ON ITS OWN ROW, WAS "NOTHING READ,
  NOTHING WRITTEN". AN OLD ROW THAT CARRIES THE HASH IS NEVER REWRITTEN, WAS VERIFIED IN PLACE. NOT FOUND AND THE FOUR
  FAIL-CLOSED CASES: PUBLIC COLUMNS UNCHANGED AND THE CLAIM KEPT, WAS "ROW BYTE-IDENTICAL / NO UPDATE". REJECTED: A
  GETTER CALL, WAS A 0X SWAP UNDER A 1INCH ROW. A SECOND WALLET'S TRADE IN ONE SETTLEMENT: 200 AND ITS ROW, WAS 409; AT
  ONCE: [200, 200], WAS [200, 409]. NO CHAIN NAMED AND A ROW ON BASE: ETHEREUM ASKED TOO AND 200, WAS 202. THE LOOKUPS
  OF A PATCH: THREE, ALL SCOPED TO THE WALLET, WAS A BY-HASH, A FALLBACK AND A CROSS-WALLET DUPLICATE CHECK. SET-UP (NOT
  AN ASSERTION): A PENDING ROW MEANT TO RECEIVE A SWAP NOW DECLARES THE RECEIPT'S IN TOKEN (`rowFor`).
- ROUTE.PROPERTY.TEST.TS (6): P3 ONE ROW PER (CHAIN, HASH, WALLET), WAS (CHAIN, HASH). P4 A PATCH CREATES AT MOST ONE
  ROW (VERIFIED OR CLAIM), WAS NONE. "NO ROW DISAPPEARS" IS "ONLY A SCRATCH ROW OF THE NAMED WALLET". P7 AT MOST 20
  SCRATCH ROWS, WAS 5 PENDING IN AN HOUR. 409 AND 429 LEFT THE "EVERY STATUS SEEN" LIST; RETIRED ROWS AND CLAIMS JOINED IT.
- ROUTE.POST.TEST.TS (2): THE 6TH POST: 200 AND THE OLDEST UNCLAIMED SCRATCH ROW RETIRED, WAS 429. THE CAP'S READS: TWO
  SCRATCH READS, WAS ONE COUNT.
- ROUTE.INCIDENT-REPLAY.TEST.TS (1): "VICTIM ROW CHANGED" COMPARES ITS PUBLIC COLUMNS, WAS THE WHOLE ROW (SHAPE 8 NOW
  ASSERTS THE THREE PRIVATE CLAIMS ON THEIR OWN).
- ROUTE.UNMIGRATED.TEST.TS (1): THE PROBE ASKS FOR FIVE COLUMNS, WAS TWO.
- FAKE-SWAPS-DB.SCHEMA.TEST.TS (3): FIVE ADD COLUMN, WAS TWO; THE INDEX INCLUDES LOWER(WALLET); FIVE NEW COLUMNS.
- VERIFY-STORED-SWAPS.TEST.TS (3): A "MARK" ROW LISTS CALLERCOLUMNS; AN INVENTED WALLET ON A FEECOLLECTOR SWAP:
  NO_SWAP_EVENT, WAS WRONG_SENDER; A MADE-UP SOURCE: STORED_DIFFERS, WAS BAD_SOURCE.
- BROWSER RIG (E2E/SWAP-LOG): THE WAIT IS FOR A PATCH ANSWERED 200 (WAS ANY PATCH); PLAYWRIGHT'S OWN "SERVICE WORKER
  REGISTRATION BLOCKED" LINE IS COUNTED APART FROM THE PAGE'S CONSOLE AND COMPARED WITH MAIN AS A COUNT (RUN 1 FAILED
  ON ITS POSITION, R4); THE NEW LAG MODE HAS ITS OWN EXPECTED ANSWERS. THE NORMAL MODE'S ASSERTIONS ARE AS THEY WERE.

## R7. Notes and concerns of round 2

- A FeeCollector swap's in side is the event's `totalAmount`, as details H.1 says. The FeeCollector returns unused input
  and the router call is the caller's, so a call that sends most of the input back (a SwapRouter02 pull + sweep inside
  `routerData`) is counted at `totalAmount` while only the fee (FEE_BPS 10 = 0.1%) really leaves: 1,000 USD of fake
  volume costs about 1 USD of fee to the FeeCollector, once per transaction. Not probed on a fork. Netting the wallet's
  own legs for fee_collector too would close it, but it is not what H.1 says: for the owner.
- A third party can still make work for a wallet: invented hashes become claim rows of that wallet (bounded by details
  J, 20 scratch rows, and the per-IP limit of the log routes), and naming a wallet with that wallet's REAL transaction
  records it for that wallet (correct data). Both are the unauthenticated log routes (API-HIGH-02, pre-existing).
- A claim stored with no chain sits on a claim row whose `chain_id` is the registry's first (1); `claimed_chain_id` is
  null and every chain is asked again. The row is private and pending; the History tab shows it as a pending row with
  no tokens until it is decided (the official client always names its chain and always has a POST row, so it does not
  make one).
- An old row (written before this change) that already carries a hash is never touched by a confirmation; a
  confirmation of that transaction makes a new verified row. Flag off, main's counters then count both rows; flag on,
  only the verified one. The stored-rows script then reports the old row `duplicate_tx` on --apply.
- 41 real 0x transactions in round 1's sample (other platforms' traffic) are now rejected (R3); round 1 counted them
  at the ETH value. The official client's own ETH -> token swaps are not of that shape.
- origin/main moved twice during the round: 5b526e7d..fe3ab13b (PR #727, scripts) merged first as the goal says
  (64475599), then fe3ab13b..623f58fd (PR #730, one workflow file) merged before the verify (c4ce9030), as in round 1:
  no file of this branch touched, so the one verify ran against the current main. `npm ci` ran after the first merge;
  the lockfile did not change in the second.
- No production host or database was called. Real receipts were read from public nodes (mainnet.base.org for S-8);
  the fork receipts were made on local anvil forks of the three chains (127.0.0.1), whose state was read through
  public nodes. No software was installed; anvil and gitleaks were already there. gitleaks over the round's commits: no
  leaks.
