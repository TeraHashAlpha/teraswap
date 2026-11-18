# fix/server-builds-order-data — A86 S-4/S-5 + A89 R2-1..R2-5

Premise read on origin/main 85a6f9cb: true (route.ts:809 stores `body.orderData ?? null`; M-07 :446-477; v3 by `typeof` :292,
keeper by presence executor-routing.js:25).

## Checklist
- [ ] Step 0: every `order_data` key and its readers (table below)
- [ ] Owner question asked once (maxDuration, non-signed keys, orderData absent)
- [ ] route.ts POST: server builds `order_data` from the verified message; `maxSlippageBps` iff v3; `routerData` only after its hash check
- [ ] Caller `orderData` that differs: request unchanged, one line with the field NAMES
- [ ] R2-1 signature-fragment log · R2-3 3 s abort + 503 + `maxDuration` · R2-4 wallet filter
- [ ] R2-2 / R2-5 in scripts/orders/check-order-hashes*
- [ ] Tests: 300-order differential (keeper builder sliced from executor.js, Foundry getOrderHash), 11 bent cases + v2 with maxSlippageBps, S-1 asserts order_data, R2-1/R2-3/R2-4, mutation proof
- [ ] agent-verify once (load < 10), push, compare link
