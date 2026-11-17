# fix/orders-server-side-order-hash: S-5, the server computes the stored order hash

Goal: audit 2026-11-16 S-5. `POST /api/orders` stored `order_hash: body.orderHash` as sent; duplicates were refused only
by that text. Fund-flow adjacent: Draft PR, Auditor required. Premise read at `b47ca15e`, branch off `origin/main`
`4a4129ef` (route, contract and keeper unchanged between the two).

## Checklist
- [ ] Read: route + `[id]` route + tests, every `orders` writer (grep), EIP-712 types/domain, V3 `getOrderHash`, keeper hash use
- [ ] One server function: order hash from the signed fields, same types/domain as recovery, = OrderExecutorV3's hash
- [ ] POST stores the server's hash; 409 on the server's hash; response returns the stored hash
- [ ] Caller text differs: store the server's hash, one structured log line (no signature), answer as today
- [ ] Every other write path: same function, or one line why it cannot diverge
- [ ] `scripts/orders/check-order-hashes.ts` (read-only, stdin rows), run on fixtures only
- [ ] Differential >= 200 seeded orders vs the contract's own function in Foundry (all types, Base + Arbitrum, dcaTotal 1/365)
- [ ] Route tests: two texts -> one row + 409; wrong text stored as server's + logged; correct unchanged; mixed case
- [ ] Mutation proof (scratch copy): caller text stored again; one signed field dropped from the hash
- [ ] Verify: `scripts/agent-verify.sh --codeql`, `node scripts/gen-claude-state.mjs --check`, lint delta 0
- [ ] Evidence 1-5 below (long output in `fix-orders-server-side-order-hash.evidence.md`), push, compare link
