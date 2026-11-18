# fix/server-builds-order-data — A86 S-4/S-5 + A89 R2-1..R2-5

Premise read on origin/main 85a6f9cb: true (route.ts:809 stores `body.orderData ?? null`; M-07 :446-477; v3 by `typeof` :292,
keeper by presence executor-routing.js:25).

## Owner answers (asked once, 2026-11-18; they supersede the goal text)
1. `maxDuration` = 30 s. 2. tokenIn/OutSymbol, tokenIn/OutDecimals: drop. 3. No caller orderData: build order_data always.

## 1. Step 0 — `order_data` keys other than the 16 signed fields
| key | readers | decision |
|---|---|---|
| routerData | keeper pinned-route.js:69 (replayed for non-DCA) | keep only when keccak256 = signed routerDataHash (verifyRouterDataHash); else drop, never reject |
| tokenInSymbol, tokenOutSymbol | keeper executor.js:1362-1363, fallback after `token_*_symbol` column | drop (owner) |
| tokenInDecimals, tokenOutDecimals | keeper executor.js:1364, 1634-1635, fallback after the column the route always writes (`?? 18`) | drop (owner) |
| anything else | none (UI rowToOrder useOrderEngine.ts:311, cancel :410-431, basket-coordinator.js:366-373, check script read signed fields only) | drop |
Signed fields: addresses = signed text, uint256 = `BigInt(v).toString()` (viem coerces with BigInt, toHex.js:124), uint8/16 = numbers; `maxSlippageBps` iff the route decided v3.
Facts for R2-4: schema.sql:270-287 lower-cases every stored wallet (trigger), so `.eq('wallet', lower)` misses no row.
Rigs to port: 11 bent cases = `~/ts-worktrees/audit-orders-hash-probe/src/app/api/orders/zz-audit-route-l2.test.ts:463-511`;
240 re-posts = A86b `p1-encodings.test.ts` matrix A (4 kinds × 7 legacy texts × 6 encodings) + B (2 kinds × 36 pairs).

## Checklist
- [x] Step 0: every `order_data` key and its readers (table above)
- [x] Owner question asked once (maxDuration, non-signed keys, orderData absent)
- [ ] route.ts POST: server builds `order_data` from the verified message; `maxSlippageBps` iff v3; `routerData` only after its hash check
- [ ] Caller `orderData` that differs: request unchanged, one line with the field NAMES
- [ ] R2-1 signature-fragment log · R2-3 3 s abort + 503 + `maxDuration` · R2-4 wallet filter
- [ ] R2-2 / R2-5 in scripts/orders/check-order-hashes*
- [ ] Tests: 300-order differential (keeper builder sliced from executor.js, Foundry getOrderHash), 11 bent cases + v2 with maxSlippageBps, S-1 asserts order_data, R2-1/R2-3/R2-4, mutation proof
- [ ] agent-verify once (load < 10), push, compare link
