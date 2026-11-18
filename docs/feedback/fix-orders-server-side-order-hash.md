# fix/orders-server-side-order-hash: S-5, the server computes the stored order hash

Audit 2026-11-16 S-5. Fund-flow adjacent: Draft PR, **Auditor required**. Premise read at `b47ca15e` and true
(`route.ts:741` stored `body.orderHash`); branch off `origin/main` `4a4129ef`. No owner question was needed.
Long output: [`fix-orders-server-side-order-hash.evidence.md`](fix-orders-server-side-order-hash.evidence.md) (E1-E6).

- [x] Read route, `[id]` route, tests, every `orders` writer, EIP-712 types/domain, V3 `getOrderHash`, keeper hash use
- [x] One server function, POST stores its hash, 409 on it, observe-mode log, other writers listed, check script
- [x] Differential, route tests, mutation proof, verify, push

1. **Write paths (E1).** Only the POST insert writes `order_hash`: `src/app/api/orders/route.ts:772`, now
   `serverOrderHash` (computed `:393`), was `body.orderHash`. The others never write it: `[id]/route.ts:145` (cancel
   status; it and its tests `orders-cancel{,.arbitrum-v3-only}.test.ts`, `route.hardening.test.ts:206`,
   `orders-freeze.test.ts:243` key on id + wallet + chain_id, never `order_hash`; unchanged, all pass), keeper `executor.js:687/:707/:736/:908` (status, retry, execution fields), `backfill-execution.mjs:282`
   (execution fields; it looks rows up BY `order_hash` = the OrderExecuted topic, `:169`). `contracts/order-engine/api/orders.ts:165`
   still stores `body.orderHash` but cannot diverge: a reference file, not under `src/app`, imported nowhere. No SQL writer.
2. **Hash (E2).** `computeOrderHash` = EIP-712 `hashStruct(Order)` over the route's own `types` + `message` = the
   contracts' `getOrderHash` (V3 `:1149`, v2 `:964`), the key of `cancelledOrders`/`dcaExecutions`. The domain enters
   only the digest recovery checks (`_hashTypedDataV4`, V3 `:360/:449`); that is checked too. Foundry
   `OrderHashDifferential.t.sol`, the contracts' own `getOrderHash` + `domainSeparator()` at the production address and
   chain id: **352/352 equal** (V3 Base 128 seed 8453001, V3 Arbitrum 128 seed 42161001, v2 Mainnet 48 seed 1002,
   v2 Base 48 seed 8453002; all order types; DCA `dcaTotal` 1 and 365).
3. **Route tests (E3), 11/11.** Two texts → one row + 409; wrong text → stored as the server hash, one
   `orders_order_hash_mismatch` line, no signature; correct hash → unchanged; upper case / `0X` / no prefix → accepted,
   no log. Real signatures and recovery, `UNIQUE(order_hash)` table, `fetch` guarded. 206 existing route tests unchanged.
4. **Mutation (E4).** Caller's text stored again → 9 tests fail. `nonce` dropped from the hash → 20 vitest fail, and
   4/4 Foundry differentials fail even with the vectors regenerated from the mutant.
5. **Verify (E6)** at code head `341a9357`: `agent-verify.sh --codeql` RESULT PASS (suite 10897/0, lint +0/+0, tsc 0,
   build, parity, rpc-budget, CodeQL 13 = 13, 0 new; a first run read 20 because the OZ submodule was checked out for
   forge, cause measured in E6); `gen-claude-state --check` current; gitleaks clean; forge 124/124 + 19/19.
   diff: 17 files, +2214/−48 before these two docs files. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/orders-server-side-order-hash
   **Not verified:** the check script on production rows (fixtures only, as asked); that the live DB has
   `unique_order_hash` (`schema.sql:114` assumed); that Vercel shows the `console.warn` line; keeper suite (untouched);
   CI (not polled).

**Observe → reject later.** After a period with zero `orders_order_hash_mismatch` lines (the official client already
sends the struct hash, `useOrderEngine.ts:778/933`) and a clean `check-order-hashes` run on production rows: in
`route.ts`, replace the `console.warn` in the mismatch block (just before the insert) with
`return NextResponse.json({ error: 'orderHash does not match the signed order' }, { status: 400 })`, and change the two
"wrong hash text" tests to expect 400 and no row.

## Feedback — S-5 (`395e3b3a`, `23098602`, `60be03c7`, `341a9357`)

### Concern
- The M-07 `order_data` cross-check (`route.ts:434-466`) skips orderType, condition, targetPrice, priceFeed, expiry,
  nonce, dcaInterval and dcaTotal, and the keeper executes `order_data` (`executor.js:1571`). Such a row is stored
  `active` but can never execute (on-chain signature check fails); `check-order-hashes` reports it as `differs`.
- v3 is decided differently: route `typeof body.maxSlippageBps === 'number'`, keeper `od.maxSlippageBps != null`
  (`executor-routing.js:25`).

### Edge case
- Rows written before this change keep the caller's text: re-posting such an order now adds a second row. Run
  `check-order-hashes` on production rows before relying on `order_hash` uniqueness (`useOrderEngine.ts:1223` mentions
  UUID hashes).

### Test gap
- No pre-existing route test asserted the stored `order_hash`.
