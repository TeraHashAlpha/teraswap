# fix/server-builds-order-data — A86 S-4/S-5 + A89 R2-1..R2-5

Premise true on origin/main 85a6f9cb. Owner answers (asked once, 2026-11-18; they supersede the goal text): `maxDuration`
30 s; token symbols/decimals dropped from order_data; order_data built even when the caller sends no orderData.

## 1. Step 0 — `order_data` keys besides the 16 signed fields
| key | readers | decision |
|---|---|---|
| routerData | keeper pinned-route.js:69 (replayed for non-DCA) | kept only if it hashes to the signed routerDataHash (one check); else dropped, never refused |
| tokenIn/OutSymbol, tokenIn/OutDecimals | keeper executor.js:1362-1364, 1634-1635, fallback behind the row column | dropped (owner) |
| any other | none: UI useOrderEngine.ts:311/:410, basket-coordinator.js:366-373, check script read signed fields | dropped; counted, never named |
Signed fields come from the verified message: address/bytes32 as signed, uint256 `BigInt(v).toString()` (viem's own coercion),
uint8/16 numbers; `maxSlippageBps` iff the route decided v3; re-hashed before insert (must equal order_hash).

## 2. The auditor's 11 bent cases (A86 "checks 2+9"; the same 11 posts on origin/main's route.ts vs this branch)
| | status | order_data = signed | keeper routes | keeper struct hash = order_hash, sig recovers owner |
|---|---|---|---|---|
| before | 201 ×11 | 0/11 | the 2 v2-signed orders carrying maxSlippageBps → **v3** | 0/11 ("Invalid signature" on-chain) |
| after | 201 ×11 | 11/11 | signed version 11/11 (those 2 → v2) | 11/11 |

## 3. Differential (orders-order-data-differential.test.ts + OrderDataDifferential.t.sol)
300 orders (v3 Base 120 Limit/TP/DCA, v3 Arbitrum 80 DCA, v2 Base 60 and Mainnet 40 Limit/TP/DCA), one key each, bodies varied
(official, no orderData, extra keys, bent copy, spellings, wrong orderHash): 300/300 201; the keeper's routing call and struct
literal (sliced from executor.js, resolveExecutorRouting imported) pick the signed executor, the struct hashes to order_hash
(server fn and contract-style), the signature recovers the owner, pinned calldata replays. Foundry 5/5: the executors' own
getOrderHash at the production address/chain = stored hash for all 300; struct chain = keeper digest (a flipped hash or digest fails).

## 4. R2-1..R2-5
R2-1: r, s, middle window, last 64 hex, upper case without 0x, twin's s as orderHash → `<signature fragment len N>`, 0 fragments in
console. R2-2: same 6 windows in the check script → fragment on stdout and stderr. R2-3: hung / 503 / `Retry-After: 5` lookup →
503 in 3.02 s via real supabase-js, nothing inserted; `maxDuration = 30`. R2-4: `.eq('wallet', lower)` (trigger lower-cases every
wallet, schema.sql:270-287): A86b matrices 168 + 72 = 240 re-posts all 409; real query `wallet=eq.<lower>`. R2-5: id holding a
signature → `<redacted len 132/130>`. Mutants all killed: caller's nonce (6 fail), v3 presence from caller (4), route v3 from
orderData (43), caller copy stored (36), no deadline (3), unlowered wallet (4), check script (7, 6, 2).

## 5. Changed expectations
- orders-server-order-hash.test.ts S-1, 20 cases: THE STORED ORDER_DATA IS THE SIGNED ORDER, NOT THE CALLER'S BENT COPY (was
  `order_data: firstData`); each also asserts the differs line names the bent keys.
- 8 lookup mocks: CALL SHAPE ONLY (`.eq().or().limit().abortSignal()`); no assertion changed.

## 6. Verify
- agent-verify `--codeql --keeper`, once, quiet machine (load1 9.48 → 6.41, no other verify/CodeQL), on 71cee5f3: suite 11216/0,
  lint +0, tsc 0, build ok, parity 123/0, rpc-budget 36/0, keeper Node 20 and 22 2051/0/0; **CodeQL FAIL**: 13 = 13, but the 6
  pre-existing route.ts presence-check `js/user-controlled-bypass` alerts changed message (they cited a 2nd `verifyRouterDataHash`).
- Fix 1 (65538c7d: ONE hash check, shared by the pinned refusal and order_data). CodeQL re-run alone (same suite, codeql-local.sh,
  `agent-verify --codeql-diff` vs that run's base SARIF): 11 vs 13, **0 new**; the 6 match base text. Not reported any more, not
  suppressed: base route.ts:496/:508 (pinned-route presence checks), which now also test `pinnedOrder` while the hash check runs
  for every order. On 65538c7d: full suite 11216/0, build ok, tsc 0, eslint 0. forge: order-engine 129/0 (5 new), FeeCollector 19/0.
- 21 files, +2016 −85 (code head 65538c7d; this file is the last commit). gitleaks clean.
  Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/server-builds-order-data
- NOT verified: CI; agent-verify as a whole on 65538c7d (parity, rpc-budget, keeper not re-run; no UI/keeper file changed); a live
  Supabase/PostgREST (stubs; the wallet trigger read from schema.sql, not the prod DB); a keeper process or on-chain canExecute with
  a server-built row (keeper code sliced and run, getOrderHash in Foundry); Vercel honouring `maxDuration`.
