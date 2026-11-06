# fix/infra-failures-dont-burn-orders — FEEDBACK (Code Agent; 2026-11-04)

## Checklist
- [x] Worktree `~/ts-worktrees/infra-failures-dont-burn-orders` off origin/main a5cd8fe, real `npm ci` (root + executor), SSH-signed noreply committer
- [x] C1 classify every miss (`classifyMissCause` / `classifySwapApiMiss`, plan carries `cause`), ADR-026 Proposed, index row
- [x] C2 only `order` misses count; infra ⇒ `last_attempt_at` + `last_infra_miss_*`, order alive; paused ⇒ no attempt; migration (manual)
- [x] C3 visibility: `/api/monitor/keepers.infraMissOrders24h` + daily report + `/health.infraMisses` + runbook § 8
- [x] Verify: keeper suite Node 20.20.2 + 22.23.4 (0 cancelled), vitest, lint, tsc, CodeQL 0 new · [x] push + compare link

## 1. Cause table
ADR: `docs/ADR/ADR-026-infra-failures-dont-burn-orders.md` § Decision 1 (the table lives there; one line per site).
infra = paused:rpc-auth · rpc-auth · rpc-transport (5xx/429/timeout/socket/fetch failed) · keeper-gas · receipt-unavailable ·
swap-api:<5xx|429|network|misroute> · keeper-config · unclassified (thrown, no tx sent). order = reverted (mined) ·
revert[:Name|swap-failed] · allowance/balance/nonce codes · no-route[:<4xx>|no-tx-data] · expired · unknown (no evidence, legacy).
Not misses (unchanged, never counted): gas-tier / deviation / quorum-skip / floor-breach / cap-delay / pinned-route-revert /
submission-refused / routing-gap / canExecute=false / lock conflict.

## 2. Counter logic before → after
- Before (origin/main a5cd8fe): `retry-policy.js:433-434` — every non-expired miss did `failures = base + 1`; `executor.js:787` took no
  evidence; sites `executor.js:1591` (no-route), `:2006` (mined revert, `{}`), `:2090` (catch) all reached that one increment.
- After: `retry-policy.js:160` `classifyMissCause` tags the miss; `:617` the `infra` branch returns `kind:"infra"`, `failures` = the
  row's count, patch = `buildInfraMissPatch` (`:73`: active + last_attempt_at + last_infra_miss_at/_reason, NO consecutive_failures);
  `:644` is the unchanged `base + 1` and now only `order` misses reach it. `executor.js:1387` paused gate (no lock/tx/count);
  `:826` handler takes the evidence, `:870` logs "NOT counted"; sites `:1658` / `:2075` / `:2161`; `:744` + `:789` tolerate the
  absent columns.
- Migration `supabase/migrations/20261104120000_orders_infra_miss.sql` (2 nullable columns + 1 partial index, mirrored in
  `contracts/order-engine/schema.sql`) — **apply MANUALLY to live Supabase**; order vs keeper restart does not matter.

## Judgement calls (owner's answer supersedes)
- `swap-api:misroute` (our API returned calldata for another router) and `keeper-config` are **infra** — nothing the user did.
- A 4xx from `/api/swap` (priceGuard / INVALID_SOURCE / no route) is **order**: the API answered; the pair has no acceptable route.
- `unclassified` (a throw before any tx that no rule recognises) is **infra** by the ambiguity rule — including a keeper bug.
- Per-order RPC auth misses are NOT fed to the rpc-auth monitor (no new origin): the cycle-start balance read is the probe.
- `last_attempt_at` moves on an infra miss (owner ask) ⇒ an order already mid-ladder keeps its `backoffMs(count)` (≤ 30 min) from the
  LAST attempt; count 0 (the common case) retries on the very next healthy cycle. Pinned by test.
- An infra-missing order is never capped: the only signals are the RPC alerts + the 24 h count (C3). A keeper bug that throws for one
  order is `infra:unclassified` ⇒ also uncapped (visible in the log + count).

## Premises checked
- "reuse rpc-auth.js classification": done (`classifyRpcError` imported into retry-policy.js; a revert saying "not on whitelist" stays order).
- `orders.error` cannot hold the infra reason: `DcaOrdersList.tsx:110` shows any non-null `error` as a failed order ⇒ two new columns.

## 3. Test matrix (`infra-miss-ladder.test.mjs` 19 + `miss-cause.test.mjs` 25 = 44/44 on Node 22; same on 20)
auth outage 20 cycles ⇒ count 0, active, `last_infra_miss_reason=rpc-auth`, then healthy ⇒ exactly one fill ✓ · paused ⇒ 20 cycles,
row byte-identical, first healthy cycle fills ✓ · 503 outage over 2.5 DCA intervals ⇒ count 0, ONE chunk on recovery, next chunk
exactly `lastExec + interval` (no back-fill) ✓ · sent-and-reverted ⇒ +1 ✓ · 8 order misses ⇒ `failed` + alert as before ✓ ·
MIXED 3 order / 20 infra / 4 order ⇒ active at 7, 8th ORDER miss fails (28 attempts) ✓ · fill resets count, keeps trail ✓ ·
backoff from last attempt ≤ 30 min, restart-proof ✓ · columns tolerated when absent (both-missing order too) ✓ · cause table 21 ✓.

## 4. Suites
Keeper `node --test`: **877/877, 0 fail, 0 cancelled** on Node 20.20.2 AND 22.23.4 (CI versions; tarballs SHA-verified). One earlier run
tripped `chain-verify` "10x input … exceeds RATIO_BOUND" while vitest+lint+tsc ran concurrently — the known timing flake (file untouched),
0/3 on a quiet machine. vitest 411 files / 6580 pass · eslint 0 errors / 93 warnings (unchanged, cap 94) · tsc clean ·
CodeQL `javascript-security-extended` (codeql-local.sh): **13 → 13, 0 new** (same file:line set as after #653: orders/route.ts ×8, auth.ts:47,
api-auth.ts:94, fingerprint-validator.ts:319, capture-endpoint-baseline.ts:54, telegram/webhook:163).

## 5. Diff + link
`git diff --stat origin/main..HEAD`: 17 files, +1328/−26 (before this file's final edit). 3 signed commits (classify / counter / visibility).
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/infra-failures-dont-burn-orders — owner opens the PR as DRAFT;
**Auditor required** (keeper execution logic). Migration `20261104120000_orders_infra_miss.sql` is applied MANUALLY by the owner.

## A73 fix pass (2026-11-04) — one commit per id, each test red on the previous head
| Id | Sev | Fix | Commit | Test (red → green) |
|---|---|---|---|---|
| S-1 | H | `/api/swap` catch: adapter no-route (`adapters/shared.ts isNoRouteError`, the friendlyError rules) ⇒ 422 `code: NO_ROUTE`, `error` text unchanged (v1 `useSwap.ts` + v2 same hook — SwapBox/useSwap/v2-lifecycle 11 files / 226 tests pass untouched); `PRICE_GUARD` / `ORACLE_UNAVAILABLE` codes added to the two 422s. Keeper `classifySwapApiMiss` by CODE (NO_ROUTE, unpriced_ack_required, PRICE_GUARD ⇒ order; ORACLE_UNAVAILABLE, config codes, 429/5xx, payload 400, unknown code / un-coded 4xx ⇒ infra); `fetchSwapRoute` parses the body code. Floor backoff: in-memory `orderInfraMisses` streak, gate waits `backoffMs(streak)` (ladder cadence, ≤ 30 min), no counting, cleared by any order miss / fill. | `5c94cd4` | `shared.test.ts` +2 · `swap/route.test.ts` +5 (+2 codes) · `miss-cause` code table · `infra-miss-ladder` +5 (5 attempts / 20 polls; ~10 in 2.5 h) |
| S-2 | M | revert guard (`ContractFunctionRevertedError` / REVERT_NAME / REVERT_TEXT) evaluated before KEEPER_GAS_TEXT; viem `InsufficientFundsError` with no revert still keeper-gas | `e664493` | `miss-cause` "[A73 S-2]" |
| C(3)+C(1) | M | per-order in-memory unrecognised streak (`unclassified`, `swap-api:misroute`, `keeper-config`): ONE critical-tier `alertOps infra-miss-streak` at 20 misses OR ~10 min since the run began (floor backoff ⇒ the time rule fires on the 6th, 15.5 min), 1 h cooldown; reset by any other infra reason, order miss or fill; order never burned | `eb9414b` | `infra-miss-ladder` "[A73 C(3) / C(1)]" 6 |
| S-3 | L | `minedRevert` evaluated before `paused` | `b180fae` | `miss-cause` sent-and-reverted +1 |
| S-4 | L | `countInfraMissOrders24h` ⇒ `{ count, status: ok\|missing\|error }`; route passes `infraMissStatus`; report token `<n>\|unknown\|error`; `error` ⇒ ⚠️ + WARNING + bullet, `unknown` ⇒ ℹ️ | `d76d0d3` | health-monitor 4 · route 1 · daily report 2 |
| S-5 | L | `idx_orders_last_infra_miss_at` mirrored in `schema.sql`; migration OPS note: `CREATE INDEX CONCURRENTLY … ` run alone (cannot run inside a transaction) | `7a2c58f` | `infra-miss-ladder` migration anchor +3 |
| S-6 | L | count filtered `status in (active, executing)`; ADR §5 + runbook SQL | `f206d0a` | health-monitor stub requires `.in('status', …)` |

Judgement calls (owner's answer supersedes): a 422 WITHOUT a code (an older API deploy) and today's no-route 502 are `infra` until the
API deploys NO_ROUTE — no order burns in the transition; a 2xx without `tx.data` moved from order to `infra:swap-api:no-tx-data`
(our contract); C(3)'s "≈20 / ~10 min" is implemented as count-OR-time because the S-1 floor backoff makes 20 misses take hours.
Recovery latency after a long outage ≤ 30 min (the capped infra window) — the Auditor's cadence, replacing "next healthy cycle".

Verify (A73 tree f206d0a): keeper **891/891, 0 cancelled** on Node 20.20.2 + 22.23.4 · vitest 411 files / **6588** pass · eslint 0 errors /
93 warnings (unchanged) · tsc clean · CodeQL `javascript-security-extended`: **13 → 13, 0 new** (same file:line set).
Diff since the audited head 6e711c8: 18 files, +595/−99 (before this file's edit). #656 stays a DRAFT.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/infra-failures-dont-burn-orders

## A73b fix pass (2026-11-05) — one commit per id, each test red on the previous head, REAL viem 2.47.10 objects
Every new keeper test builds its errors through viem's OWN `readContract(canExecute)` / `writeContract(executeOrder)` (this
directory's `node_modules/viem`) against a local JSON-RPC stub (`viem-wrapped-errors.fixture.mjs`) — wrapped exactly as the
executor receives them, never a bare inner error. Owner's merge of main (4e000cc) was fast-forwarded first; root `npm ci` re-run.
| Id | Sev | Fix | Commit | Test (red → green) |
|---|---|---|---|---|
| S-7 | H | `REVERT_NAME = /Revert/` — the wrappers (`ContractFunctionExecutionError`, `CallExecutionError`, `EstimateGasExecutionError`) are gone; a revert needs POSITIVE evidence anywhere in the chain (a `/Revert/` name, revert text, a decoded executor error / `SwapFailed` reason). The node's insufficient funds anywhere in the chain ⇒ `keeper-gas`; the keeper's tx nonce rejected (`NonceTooLow/TooHigh/MaxValueError` or words) ⇒ new infra label `keeper-nonce` (never on a revert) | `71bee41` | `wrapped-viem-errors` S-7: funds @ estimateGas / @ sendRaw / on eth_call ⇒ keeper-gas, nonce ⇒ keeper-nonce, end-to-end count 3 stays 3; S-2 guard with real reverts (coded, geth, `Error("insufficient funds for transfer")`) stays order — 5 red on 4e000cc |
| S-8 | H | transport / HTTP / timeout anywhere in the chain ⇒ `rpc-transport`, decided BEFORE the permanent text rules whenever nothing reverted (a provider's page saying "insufficient balance" / "exceeds allowance" was a TERMINAL `failed`); old rule 9 folded into `isTransportMeta` | `ec5004b` | `wrapped-viem-errors` S-8 matrix: 7 answers × 3 sites (read canExecute, write @ eth_estimateGas, write @ eth_sendRawTransaction) + 3 end-to-end — the 5xx / 429 / timeout cases already green after S-7; the two page-text cases (×3 sites) + 1 end-to-end red on 71bee41 |
| S-9 | L | expiry pre-filter `clearInfraMisses`; every cycle `pruneInfraMisses(orderInfraMisses, ids just fetched)` before the loop (an empty fetch — also a Supabase error — leaves the map alone; bounded by the last active set). The keeper has no cancel path: cancel = absence from `fetchActiveOrders` | `61720c8` | `infra-miss-prune.test.mjs`: pure helper 5 + executor anchors 3 — red on ec5004b (missing export) |
| S-10 | L | `adapters/shared.ts`: the four earlier friendlyError rules (network / timeout / 429 / 403) are named predicates both functions apply in the SAME order; `isNoRouteError` is false when one of them claims the message; copy strings unchanged | `d7aed7f` | `shared.test.ts` +2 (7 outage messages with route words ⇒ false; NO_ROUTE ⇔ the liquidity / no-route copy over 20 samples) · `swap/route.test.ts` +4 (⇒ 502, no code) — 6 red on 61720c8 |

### Wrapped-error matrix (`wrapped-viem-errors.test.mjs`; chains printed by viem's own `BaseError.walk`, outermost first)
CFEE = ContractFunctionExecutionError · CEE = CallExecutionError · TEE = TransactionExecutionError · EGEE = EstimateGasExecutionError ·
CFRE = ContractFunctionRevertedError · ERE = ExecutionRevertedError · IIRE = InvalidInputRpcError · RRE = RpcRequestError.
Write @ `eth_sendRawTransaction` is the write chain without the EGEE link (same class).
| Provider / node answer | read `canExecute` | write `executeOrder` @ `eth_estimateGas` | Class now | Class on 4e000cc |
|---|---|---|---|---|
| HTTP 503 / 429 / 502 HTML page | CFEE › CEE › HttpRequestError | CFEE › TEE › EGEE › HttpRequestError | `infra:rpc-transport` | `order:revert` |
| timeout (hung provider) | CFEE › CEE › TimeoutError | CFEE › TEE › EGEE › TimeoutError | `infra:rpc-transport` | `order:revert` |
| HTTP 403 allowlist | CFEE › CEE › HttpRequestError | CFEE › TEE › EGEE › HttpRequestError | `infra:rpc-auth` | `infra:rpc-auth` |
| HTTP 503 page "insufficient balance" | CFEE › CEE › HttpRequestError | CFEE › TEE › EGEE › HttpRequestError | `infra:rpc-transport` | `order:insufficient_balance` (TERMINAL) |
| HTTP 402 page "exceeds allowance" | CFEE › CEE › HttpRequestError | CFEE › TEE › EGEE › HttpRequestError | `infra:rpc-transport` | `order:insufficient_allowance` (TERMINAL) |
| node "insufficient funds for gas * price + value" | CFEE › CEE › InsufficientFundsError › IIRE › RRE | CFEE › TEE › InsufficientFundsError › EGEE › InsufficientFundsError › IIRE › RRE | `infra:keeper-gas` | `order:revert` |
| node "nonce too low" | CFEE › CEE › NonceTooLowError › IIRE › RRE | CFEE › TEE › NonceTooLowError › EGEE › NonceTooLowError › IIRE › RRE | `infra:keeper-nonce` | `order:revert` |
| revert code 3 + `InsufficientOutput()` data | CFEE › CFRE › CEE › ERE › RRE | CFEE › CFRE › TEE › ERE › EGEE › ERE › RRE | `order:revert` (`revert:InsufficientOutput` once decoded) | `order:revert` |
| revert geth −32000 "execution reverted: …" | CFEE › CEE › ERE › IIRE › RRE | CFEE › TEE › ERE › EGEE › ERE › IIRE › RRE | `order:revert` | `order:revert` |
| revert `Error("insufficient funds for transfer")` | CFEE › CFRE › CEE › ERE › RRE | CFEE › CFRE › TEE › ERE › EGEE › ERE › RRE | `order:revert` (S-2 guard) | `order:revert` |

Judgement calls (owner's / Auditor's answer supersedes): S-7 and S-8 share one mechanism, so the plain 5xx / timeout cases turn
green with S-7's commit; S-8's own red tests are the provider pages whose words match `PERMANENT_SIGNATURES` (a terminal burn
on 71bee41) — the transport-before-text precedence is S-8's change. `keeper-nonce` is a NEW infra label (self-healing, not in the
unrecognised set). The chain is walked by `collectErrorMeta` (every `cause` link, as viem's `.walk()` visits them; depth-bounded,
cycle-safe — non-viem `fetch` errors reach the classifier too); each test documents its shape through viem's own `walk`.
Edge case recorded, NOT changed (pre-existing, outside A73b): geth's `gas required exceeds allowance (N)` at `eth_estimateGas` —
viem labels it `ExecutionRevertedError` (its nodeMessage) and its text matches PERMANENT `/exceeds allowance/` ⇒ terminal
`insufficient_allowance`. Ambiguous: the keeper's balance-capped gas allowance (ours) vs. an order that panics / runs out of gas
at the cap (the order's). Left as is — owner / Auditor call.

Verify (A73b tree d7aed7f): keeper `node --test` **935/935, 0 fail, 0 cancelled** on Node **20.20.2** AND **22.23.4** (CI versions, run alone)
· vitest 415 files / **6674** pass · eslint 0 errors / 93 warnings (unchanged, cap 94) · tsc clean · CodeQL `javascript-security-extended`
(codeql-local.sh): **13 → 13, 0 new** (same file:line set: orders/route.ts ×8, auth.ts:47, api-auth.ts:94, fingerprint-validator.ts:319,
capture-endpoint-baseline.ts:54, telegram/webhook:163) · gitleaks over the 4 commits: no leaks. Root `npm ci` re-run after the owner's
merge of main (framer-motion 12.43.0). Diff since the audited head 4e000cc: 11 files, +730/−22 (before the docs commit). #656 stays a DRAFT.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/infra-failures-dont-burn-orders

## A73c fix pass (2026-11-05) — one commit per id, each with a real-viem test red on the previous head
The Auditor's candidate diff was read as reference; implemented and tested here. Every test builds its error through viem's own
`readContract` / `writeContract` against the stub (now also answering a non-2xx that carries a JSON-RPC body).
| Id | Sev | Fix | Commit | Test (red → green) |
|---|---|---|---|---|
| S-12 | H | viem's `getContractError` wraps ANY −32603 (`InternalRpcError`) as `ContractFunctionRevertedError` — also on a 5xx with a JSON-RPC body (viem returns it into the RPC pipeline; no status survives). Such a chain is a revert only with an `ExecutionRevertedError` or hex revert data (≥ 4 bytes: `data` on RpcRequestError, plain or nested, or CFRE.`raw`); otherwise keeper-gas / keeper-nonce if the node said so, else `rpc-transport` | `7c4cbc2` | S-12: 3 answers × 3 sites ⇒ infra:rpc-transport, −32603 funds / nonce ⇒ keeper-gas / keeper-nonce, 20 misses never move the ladder — 11 red on e05223d; real reverts under −32603 (hex data, nested data, "execution reverted" words) stay order |
| S-11 | M | `/(?<!gas required )exceeds allowance/` — geth's `gas required exceeds allowance (N)` is `order:revert`, counted on the 8-miss ladder, failed only at the cap (`no_route_after_retries` + alert), never terminal | `de2ba8c` | S-11: estimateGas + eth_call shapes ⇒ order:revert, plan retry 3 → 4, 8th miss at the cap — 4 red on 7c4cbc2; a genuine `ERC20: transfer amount exceeds allowance` revert stays terminal |
| S-13 | L | with an HTTP status in the chain, names / words are no revert evidence (viem turns page text "execution reverted" into an `ExecutionRevertedError` next to the `HttpRequestError`); only the executor's decoded data (`executorErrorName` / `swapReason`) is; `classifyFailure` never reads a page for a permanent cause | `a3f4ec3` | S-13: 3 pages × 3 sites ⇒ infra:rpc-transport, never failed; decoded data next to a page ⇒ order by its decoded name — 10 red on de2ba8c |
| S-14 | L | try/catch around both walks (`collectErrorMeta`, `collectErrorText`): the walk ends at the hostile link and classifies on what was read; nothing readable ⇒ `unclassified` (unrecognised infra, feeds the C(3) streak) | `b61ae48` | S-14: real viem errors made hostile (wrapper's own `name` accessor, revoked Proxy as first / innermost `cause`, throwing `details` deep in a real revert chain, both walks alone, 20 in a row) — 6 red on a3f4ec3 |

Deltas from the candidate diff (Auditor's call): (1) S-12 also accepts a nested `data.data` hex (wallet-style −32603; the real chain
already carries it on CFRE.`raw`); (2) S-13 additionally stops `classifyFailure` reading the error text when a status is in the
chain — the candidate gated only `isRevert`, which leaves a decoded name riding along with a page open to the page's words;
(3) S-12 knock-on: a −32603 carrying the node's "insufficient funds" / "nonce too low" is now keeper-gas / keeper-nonce (it was
`order:revert` through the guessed CFRE). Recorded, not changed: `rpc-auth.js classifyRpcError` loses its verdict when ITS walk
hits a hostile link (its try/catch answers transient), so a 403 with a hostile tail is `rpc-transport`, not `rpc-auth` — still infra.
The executor's other readers of the error are already guarded (`redactError`, the catch block's revert-decode diagnostics).

Verify (A73c tree b61ae48): keeper `node --test` **976/976, 0 fail, 0 cancelled** on Node **20.20.2** AND **22.23.4** (CI versions, run alone)
· vitest 415 files / **6674** pass · eslint 0 errors / 93 warnings (unchanged, cap 94) · tsc clean · CodeQL `javascript-security-extended`
(codeql-local.sh): **13 → 13, 0 new** (same file:line set) · gitleaks over the 4 commits: no leaks.
Diff since the audited head e05223d: 6 files, +365/−30 (before the docs commit). #656 stays a DRAFT.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/infra-failures-dont-burn-orders
