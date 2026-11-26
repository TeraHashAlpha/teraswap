# Feedback: fix/swap-log-verified-on-chain (ADR-029 phase 1, goal 133)

Draft PR, **Auditor required**. Tables and long evidence: `fix-swap-log-verified-on-chain.tables.md` (T1 to T7).
Addresses SEC-2 (ADR-029) and API-MED-03 (AUDIT-TOTAL.md:126); the ledger is the Auditor's to update.

## Checklist
- [x] Commit 1: verification function (details A), real receipt fixtures, tests
- [x] Commit 2: POST inserts only a private pending row; symbols from the catalog (details B)
- [x] Commit 3: PATCH `{ txHash, wallet }` verifies on-chain, one transaction one row, trackers after confirmation (details C)
- [x] Commit 4: migration text and schema.sql mirror; code works before it is applied (details E)
- [x] Commit 5: readers behind `SWAPS_PUBLIC_VERIFIED_ONLY`, default off (details D)
- [x] Commit 6: script for stored rows, report mode by default (details F)
- [x] Tests of details G: route replay, property, differential, browser v1 and v2, mutation proof
- [x] One `scripts/agent-verify.sh --codeql` run on the last code commit; result here; push

## Owner answers (2026-11-25; they supersede the details text)
Four asked in one question before any code; the fifth when real receipts showed one more premise false.
1. **Sides**: fee_collector reads the FeeCollector's own `SwapWithFee` event; router keeps A.6; cow the Trade event. A side still underivable is NULL; the migration also drops NOT NULL on the six token/symbol/amount columns (schema.sql:22-29).
2. **Caller fields**: on verification fee_collected, is_gasless, mev_protected, source are derived; gas_savings_usd 0, both mev fields null until phase 2; slippage and expected_output stay.
3. **Before the migration**: POST and PATCH write nothing at all, answer `{ ok: true }`, log `swaps_verified_columns_missing`.
4. **Old rows** (`--apply`): mark only when stored tokens and amount-in equal the receipt's and its amount-out is 50% to 200% of the stored one; the frozen FeeCollector V1 counts.
5. **CoW rule** (replaces A.4's "tx.to equals the settlement contract"): a Trade event EMITTED BY that chain's settlement contract whose owner is the wallet, for `cowswap` rows only. Measured: 39 of 84 recent real settlements were sent to a solver's own contract.

## Evidence
1. **A to G**: file:line and test per detail, T1. 310 new tests in 11 files.
2. **Incident replay**: nine shapes, the same file on main and here. Main fails 9 of 9 (whole incident: 99 rows with a caller-chosen status, 38 public, 47 alerts, 54 caller symbols, 1,700,000 USD stored, another wallet's row changed); here every column is 0. T2.
3. **Derivable sides**, 435 real claims: current FeeCollector 48 of 48 both sides, CoW 43 of 43, 0x router 212 of 331 (token to ETH loses the bought side). T3.
4. **Callers and readers**: 10 call sites, none changed, answered as on main (a `failed` PATCH for a transaction the chain does not have: 202; the page does not read the answer); 8 public readers on the flag, `/api/history` never. T4.
5. **Differential**: flag off, nine readers byte-identical to main (bodies and database queries); flag on, verified rows only. **Property**: seeds 133 and 20261125, 1,000 requests each. **Mutation**: 77 mutants, 77 killed by failing assertions. **Browser** v1 and v2: same prompt, console, answers and History row as main (three runs; run 2 failed on the rig's own logo 404s, fixed in the rig, assertion unchanged). T5.
6. **Verify, SHAs, diff, not verified**: below and T6.

One confirmation costs **2 chain reads** on the row's chain (plus one chain-id proof per endpoint per process); pricing moved from POST to PATCH unchanged. A transaction the node does not have: asked twice, 1.5 s apart, then 202.

TWO EXPECTATIONS CHANGED, BOTH IN TESTS THIS BRANCH ADDED (c8398736): CHAIN-READ "A NULL RESULT IS NOT RETRIED" (1 READ) IS NOW "NULL TWICE, EXACTLY TWO READS"; ROUTE.PATCH "ON THE ROW'S CHAIN ONLY" EXPECTS THE BASE READ TWICE, WAS ONCE. No expectation of a test on main changed. Why: T7.

## Feedback — goal 133 (bbe9d40e)
### Edge case
- A CoW order that "buys ETH" is an order for WETH: the verified row says WETH where main's said ETH. A reverted swap's verified row has no token or amount. A token the catalog lacks is stored as `0x1234...abcd`.
- Two wallets' trades in one CoW settlement: the second wallet's PATCH gets 409 and its row stays pending (decision 4). Smart-contract wallets and relayers (`tx.from` is not the wallet): 422. Chrome prints a console error for a 409 or 422.
- A provider node more than 1.5 s behind the browser's still leaves the row pending (202); the client does not ask again.
### Concern
- The pending cap is count-then-insert: concurrent POSTs can exceed 5, and anyone can fill a wallet's cap for an hour. History only; phase 2.
- `logger_role` may still INSERT a row with `verified_at` set (grants untouched): a column-level grant would close it.
- No confirmation depth: a receipt is trusted when it exists. USD is priced at confirmation, not at the swap's block.
- `improvements.sql:43-64`: if that cron runs, pending rows become `abandoned` after 15 minutes, not 2 hours. More in T7.

## Verify
One run, 2026-11-25 12:16 to 12:21, 1-minute load 1.5, nothing else running: **RESULT: PASS** on `bbe9d40e` (base origin/main `5b526e7d`).
suite PASS 11954 tests, 0 failed, 560 files; lint-delta PASS +0/+0; tsc PASS; build PASS; v1v2-parity PASS 123; rpc-budget PASS 36;
codeql PASS head 11, base 11, new 0 (pack 2.5.0, CLI 2.27.5); keeper not requested. No other verify run was started. Full block: T6.
- Last code commit (verified): `bbe9d40ef1315e7331023ce1509d4425f9d7a2e9`, the signed merge of origin/main (PR #728, verify tooling only) on top of `f48138da`. Docs head: the commit that adds this text (named in the hand-off message).
- `git diff --stat origin/main...bbe9d40e`: 62 files, +10695 / -266 (43 files, +7088 without the receipt fixtures and the golden); the docs commit adds only the two feedback files.
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/swap-log-verified-on-chain
- NOT verified: the migration against any database, Linux CI, a real wallet, a FeeCollector or 0x swap in the browser, the script on stored rows, the flag on in a deployment. T6.

## Round 2 (goal 133b: audit A103 at 09ddf974, blocked 0C/4H; ADR-029 section 7)
Merged origin/main (fe3ab13b, PR #727) first: 64475599. Then `npm ci`. Tables: `.tables.md` sections R1 to R6.

### Checklist
- [x] Merge origin/main, `npm ci`
- [x] 1 Verification rewritten (details H), S-8 fixture, fork fixtures for S-1/S-2/S-5 (15dcbc37)
- [x] 2 Migration and schema.sql (details K), the swaps read-columns guard, `/api/history` withholds the claim columns; the one-transaction check per wallet in code too (I.3)
- [x] 3 Confirmation and row model (details I), the client's `chainId` and three quiet retries
- [x] 4 Pending rows retired at the cap, never refused (details J)
- [x] 5 The script reads claims and lists caller-supplied columns (details L)
- [ ] 6 Tests (details M), each new one failing on 09ddf974 first; mutation; browser v1/v2
- [ ] One `agent-verify.sh --codeql` on the last code commit; result here; push

Commit order: K (migration) goes before I and J, because I and J write its new columns; each commit's content is as listed.

### Owner answers (asked once, 2026-11-26; they supersede the details text)
1. **Cap scope (J)**: the cap may delete only pending, hash-less, unverified rows created in the last hour OR carrying a claim. Oldest unclaimed first; all claimed: the oldest claim older than 24 h; else a sixth row; at 20 such rows the oldest goes whatever it carries. An old row without a claim is never deleted.
2. **ETH in only (H.3)**: a router transaction whose only in side is the ETH value and that has no out side is rejected (`no_net_swap`).
3. **Failed rows (I.2)**: a reverted result goes to the pending row whose in token is the one the call shows (ETH value; the FeeCollector call's token), else the newest pending row on that chain with the transaction's source, else a new failed row.
4. **Small calls**: a PATCH without `chainId` tries the pending rows' chains first, then the app's other chains; slippage and expected_output stay on an updated pending row (round-1 answer 2); the swaps read-columns guard is its own file, the orders guard untouched.
