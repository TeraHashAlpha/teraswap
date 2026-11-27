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
Merged origin/main (fe3ab13b, PR #727) first: 64475599. Then `npm ci`. Tables: `.tables.md` sections R1 to R7.

### Checklist
- [x] Merge origin/main, `npm ci`
- [x] 1 Verification rewritten (details H), S-8 fixture, fork fixtures for S-1/S-2/S-5 (15dcbc37)
- [x] 2 Migration and schema.sql (details K), the swaps read-columns guard, `/api/history` withholds the claim columns; the one-transaction check per wallet in code too (I.3)
- [x] 3 Confirmation and row model (details I), the client's `chainId` and three quiet retries (fbfb89d2)
- [x] 4 Pending rows retired at the cap, never refused (details J) (a11c2faa)
- [x] 5 The script reads claims and lists caller-supplied columns (details L) (34f84217)
- [x] 6 Tests (details M), failing first on 09ddf974; mutation; browser v1/v2 (fb0ff58b, 2684ff30; merge of PR #730: c4ce9030)
- [x] `agent-verify.sh --codeql` on the last code commit: run 1 red on one CodeQL alert in a new test, fixed (cbd51bcf), run 2 PASS; result here; push

Commit order: K (migration) goes before I and J, because I and J write its new columns; each commit's content is as listed.

### Owner answers (asked once, 2026-11-26; they supersede the details text)
1. **Cap scope (J)**: the cap may delete only pending, hash-less, unverified rows created in the last hour OR carrying a claim. Oldest unclaimed first; all claimed: the oldest claim older than 24 h; else a sixth row; at 20 such rows the oldest goes whatever it carries. An old row without a claim is never deleted.
2. **ETH in only (H.3)**: a router transaction whose only in side is the ETH value and that has no out side is rejected (`no_net_swap`).
3. **Failed rows (I.2)**: a reverted result goes to the pending row whose in token is the one the call shows (ETH value; the FeeCollector call's token), else the newest pending row on that chain with the transaction's source, else a new failed row.
4. **Small calls**: a PATCH without `chainId` tries the pending rows' chains first, then the app's other chains; slippage and expected_output stay on an updated pending row (round-1 answer 2); the swaps read-columns guard is its own file, the orders guard untouched.

### Evidence (round 2)
1. **Per finding** (R1): S-1 `src/lib/swap-verify/verify-swap-on-chain.ts:298`, `:323-339`; S-2 `:526-561`; S-5 `:547-559`; S-8 `:162`; S-3 `src/lib/swap-log/confirm.ts:242`, `store.ts:328`; S-4 `confirm.ts:265`, `src/lib/analytics.ts:115`, `:134`, `scripts/swaps/verify-stored-swaps-lib.ts:194`, `:280`; S-6 migration `:101`, `supabase/schema.sql:244`, `store.ts:136`. Tests `route.a103.test.ts`, `verify-swap-on-chain.a103.test.ts`, `analytics.update-swap-status.test.ts`, `swaps-read-claim-columns.guard.test.ts`. On 09ddf974: **34 of 43 new tests FAIL**; the 9 that pass are controls it already got right (a real swap, approve, a reverted call, S-8, a client naming no chain); the guard's 6 history cases fail.
2. **Reads per request** (R2): a PATCH naming its chain (every official call) at most 5 (chain-id proof, transaction 2, receipt 2); naming none at most 11 over the 3 chains, no new chain after 20 s; maxDuration 60. J: 9 edge cases pinned (R2); not atomic; a third party sending more than 20 invented hashes for a wallet after its client stopped asking can push its real claim out.
3. **Wrap / unwrap** (R3, fork): a wrap alone is ETH -> WETH, an unwrap alone WETH -> (none), each counted at its real outflow (ADR 7.6); ETH sent and refunded: rejected. Round 1's 432 real transactions: 390 confirmed, 4 failed, 41 rejected (0x calls whose bought token went to ANOTHER address; round 1 counted them at the ETH value), 0 ambiguous.
4. **Differential** flag off byte-identical to main's golden, nine readers (unchanged file); **property** seeds 133 / 20261125 (route, 1,000 each) and 133 / 20261126 (netting, 2,000 random receipts each); **mutation** 53 of 53 killed by assertions (4 survivors and 1 not applied at fb0ff58b, pinned by 2684ff30, re-run killed); **browser** v1 and v2, normal and lag mode: run 1 7 of 8 (v1 lag: Playwright's own line in another place), rig fixed with the assertion unchanged, run 2 **8 of 8**; lag: 202, then 200 two seconds later, History row, prompts and console as main (R4).
5. **Verify** (R5), each run at 1-minute load under 10 with nothing else verifying: run 1 on 2684ff30 **FAIL**, CodeQL 1 new alert (`js/identity-replacement`, a no-op replace in a test this round added; every other check PASS); fixed in cbd51bcf; run 2 on cbd51bcf **RESULT: PASS**: suite 12054 tests / 571 files, lint-delta +0/+0, tsc, build, v1v2-parity 123, rpc-budget 36, CodeQL head 11 = base 11, 0 new (pack 2.5.0, CLI 2.27.5); base origin/main 623f58fd. Last code commit (verified): `cbd51bcff74fc85eef4ea67d957e1d1b47a2809a`; docs head: the commit adding this text (hand-off message).
   Diff since 09ddf974 at cbd51bcf: this round's own code 49 files +5644 / -691 (34 files +2878 / -691 without fixtures); with main's PRs #727 and #730: 73 files +6753 / -813. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/swap-log-verified-on-chain
   NOT verified: the migration on a real Postgres; Linux CI; a real wallet, WalletConnect, a real bundler (the smart-wallet swap is a local fork's); FeeCollector and 0x swaps and Base / Arbitrum in the browser; the script against the stored table; the flag on in a deployment.

43 CHANGED EXPECTATIONS, ALL IN TESTS THIS BRANCH ADDED IN ROUND 1 (LISTED IN CAPITALS IN R6); NO EXPECTATION OF A TEST ON MAIN CHANGED. Concern for the owner (R7): a FeeCollector swap counts the event's `totalAmount`, so a call that sweeps its input back is counted in full for 0.1% fee.

## Round 3 (goal 133c: audit A104 at 2b8a9cd6, blocked 0C/2H; ADR-029 section 8)
Merged origin/main (cdae3ef5, PR #732) first: ca85d041. Then `npm ci`. Tables: `.tables.md` sections Q1 to Q6.

### Checklist
- [x] Merge origin/main, `npm ci`
- [x] 1 Router kind only for direct sources (details N) (f6b78147)
- [x] 2 ETH in side and its USD band (details O) (c6b8aec6; the analytics reader, found by the O test: 42f4a2f0)
- [x] 3 Claims on rows of their own; retired only by the chain's answer or by age (details P) (a4a60069)
- [x] 4 Budgets for chainless confirmations and chain reads (details Q) (b17df2de; the chainless limit after the migration check: e616a3df)
- [x] 5 A row main stored is verified in place (details R) (3f7410da)
- [x] 6 Tests (details S), failing on cbd51bcf first or proven by a named mutant; mutation; browser v1/v2 (a982538e, 7b2235fe, 235f13a5)
- [x] Merge origin/main again before the verify (0c31b4ce, dae5fd80, PR #731); citations (fb93dba5, comments)
- [x] `agent-verify.sh --codeql` once on the last code commit fb93dba5: PASS; result here; push

### Premise of N, checked before building it (no question needed)
The official client sends a transaction straight to a source's contract only when `usesFeeCollector(source, chainId)` is
false (`src/hooks/useSwap.ts:375`, `src/hooks/useSplitSwap.ts:301`, `src/lib/api.ts:676-677`): on 1, 8453 and 42161 that
is `0x`, `cowswap`, `bebop` (`src/lib/chains/activation.ts:39-57`). The targets are fixed per source and chain in
`ROUTER_WHITELIST_BY_CHAIN` (`src/lib/chains/routers.ts`): 0x's allowance-holder endpoint returns the AllowanceHolder as
`transaction.to` (`src/lib/adapters/zerox.ts:48-66`, `:150`; pinned by `zerox.v2-execution-path.test.ts:106-116`); Bebop's
`tx.to` must equal its settlement address (`src/lib/adapters/bebop.ts:147-167`). The client's own gate
(`useSwap.ts:425` -> `api.ts:780-805`) accepts any whitelisted router, so the per-source entry is the known set used.

### Owner answers (asked once, 2026-11-26; they supersede the details text)
1. **R (a row main stored)**: verified in place (verified_at, verified_kind, status) only when it agrees with the receipt
   by the stored-rows script's rule (status agrees, both tokens and amount-in equal, amount-out 50% to 200% of the stored
   one); no trackers. A row that disagrees is left exactly as main stored it, nothing is inserted, the answer is 200.
2. **Q.2 (read budget)**: every upstream JSON-RPC call the verification sends (each attempt, the null re-ask, an uncached
   chain-id proof, the cap check's reads) costs 1 of the 60, charged before it is sent. The Chainlink price reads after
   a verified result are not charged (once per wallet and transaction; a repeat is answered from the stored row).
3. **P.1 (claim rows)**: key (wallet, named chain or none, hash); a repeat does NOT move `claimed_at` (a claim's age
   counts from its first PATCH). When a POST row receives the verified result, that hash's claim rows are deleted; with
   no matching POST row one of them becomes the verified row. Claims older than 7 days are deleted by that wallet's later
   requests; the script is unchanged.
4. **O.2 ("no tracker call")**: no large-trade, oracle-unavailable or oracle-deviation event for that row; the
   wallet_activity line is still written, without USD.

### Evidence (round 3)
1. **Per finding** (Q1): R2-1 N `src/lib/swap-verify/verify-swap-on-chain.ts:204`, `:214`, `:569-622`; O `src/lib/swap-log/confirm.ts:98`, `:448`, `src/app/api/analytics/route.ts:219`. R2-2 `confirm.ts:326` (keepClaim), `:364` (decideClaim), `src/lib/swap-log/store.ts:327`. R2-3 `confirm.ts:294`, `store.ts:161`, `src/app/api/history/route.ts:101`. R2-4 `src/app/api/log-swap/route.ts:45`, `:232`, `src/lib/swap-verify/chain-read.ts:90-96`, `confirm.ts:284-286`. R2-5 `confirm.ts:431`, `src/lib/swap-log/stored-agreement.ts:46`.
   Tests `verify-swap-on-chain.a104.test.ts` (38), `route.a104.test.ts` (35). On cbd51bcf **52 of the first 70 fail, every one by an assertion**; the 18 that pass there and the 3 added later are each killed by a named mutant (Q4).
2. **Direct sources** (Q2): `getFeeIncompatibleSources(chain)` minus cowswap = `0x`, `bebop` on 1, 8453, 42161; targets from `ROUTER_WHITELIST_BY_CHAIN`: 0x AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734`, Bebop JamSettlement `0xbeb0b0623f66bE8cE162EbDfA2ec543A522F4ea6`, the same on the three chains. Round 1's sample: all 331 router receipts went to the AllowanceHolder; by source, 0x **293 confirmed and 2 failed still verify**, 41 rejected as in round 2, **0 rejected by N**; bebop 0 (never quoted in production).
3. **Upstream calls** (Q3), naming no chain, first / steady: E1 9 / 6, E2 3 / 0, E3 **4 / 3** (was 12), E4 **5 / 4** (was 15); E5 (E4 naming its chain) 5 / 4. Per IP and minute: **at most 60** upstream calls (was 720 to 1,440), at most 6 chainless requests.
4. **Property** P.5 seeds 133 and 20261126 (400 requests, about 12 h each, invented hashes only): the victim's claim survived 87 and 95 cap checks while its node lagged, then a cap check recorded its swap; rounds 1 and 2 properties hold (133, 20261125). **Mutation**: 37 mutants, **37 killed by assertions** (run 1 at 7b2235fe: 33 of 35, two survivors pinned in 235f13a5 and killed in run 2). **Browser** v1 and v2, normal and lag, the branch against origin/main's build: **8 of 8** twice (235f13a5 vs cdae3ef5, fb93dba5 vs dae5fd80); lag: 202 then 200, the History row as main. **Differential**: flag off, the nine readers byte-identical to main's golden (unchanged test, green).
5. **Verify**: one run on fb93dba5 at load 5.58, nothing else verifying: **RESULT: PASS**: suite 12,226 / 0 failed (575 files), lint-delta +0 / +0, tsc, build, v1-css, v1v2-parity 123, rpc-budget 36, CodeQL head 11 = base 11, 0 new (pack 2.5.0, CLI 2.27.5); base origin/main dae5fd80. Last code commit (verified) `fb93dba5c2fd2abe0fdf6f804e75bbbca06e1234`; docs head: the commit adding this text (hand-off message).
   Diff since 2b8a9cd6: this round's 11 commits 33 files +2289 / -346 (26 files +1767 / -346 without fixtures); with main's PRs #732 and #731: 62 files +3528 / -422. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/swap-log-verified-on-chain
   NOT verified: the migration on a real Postgres; Linux CI; a real wallet or bundler; 0x, Bebop or FeeCollector swaps and Base / Arbitrum in the browser; the script on the stored table; the limiter on real Upstash; real Chainlink prices; the flag on in a deployment (Q6).

28 CHANGED EXPECTATIONS IN 9 FILES, ALL IN TESTS THIS BRANCH ADDED IN ROUNDS 1 AND 2 (CAPITALS IN Q5); NO EXPECTATION OF A TEST ON MAIN CHANGED. Concern (Q6): `/api/analytics` estimated a USD for null-USD rows from the symbol, so O needed one reader change (42f4a2f0); a real ETH -> token 0x swap into a token the oracle cannot price now enters no volume (O.2).

## Round 4 (goal 133d: audit A106 at e1789dae, blocked 0C/1H; ADR-029 section 9)
origin/main had not moved (dae5fd80, already merged in round 3): no merge. `npm ci` ok.

### Checklist
- [ ] 1 R3-1: a request never writes on a row main stored; a POST naming its hash inserts nothing
- [ ] 2 R3-2: an ETH-in router row inside the band counts min(usdIn, usdOut)
- [ ] 3 R3-3: claim rows out of History's page and total, before and after the migration
- [ ] 4 Tests: failing on fb93dba5 first or a named mutant; the three named mutants; rounds 1 to 3 hold
- [ ] `agent-verify.sh --codeql` once on the last code commit; result here; push

### Owner answers (asked once, 2026-11-27; they supersede the goal text)
1. **PATCH for a hash main stored, while the chain has no receipt**: round 3's claim rule stands (a private claim row,
   no tx_hash, never public or in History, deleted when the chain answers; main's row stays byte-identical, then 200).
2. **POST naming a hash main stored for that wallet and chain**: nothing is inserted, no chain read, `{ ok: true }`.
