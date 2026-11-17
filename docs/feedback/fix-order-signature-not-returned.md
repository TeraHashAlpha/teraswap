# fix/order-signature-not-returned (S-13 of the PR #689 audit; Draft PR, Auditor required)

Goal: no read response returns the order's EIP-712 `signature`; read paths select an explicit column allow-list.
Long tables: [`fix-order-signature-not-returned.tables.md`](fix-order-signature-not-returned.tables.md).

## Owner answers (asked once, 2026-11-17; they supersede the goal text)
1. Authenticated reads: drop `signature` there too (the browser never reads it). Client type made honest:
   `OrderRow.signature` optional, `rowToOrder` maps a missing value to `''`.
2. Allow-list = the browser's `OrderRow` columns minus `signature` (30). If `floor_tier` / `floor_ack_at` are missing
   in a database (migration 20261011120000; Postgres 42703), retry once without those two.
3. POST 201 echoes the caller's own just-verified `signature` (route.ts:759): POST untouched, reported SAFE.
4. Privacy section 6 clause: "the records of its executed, cancelled, expired or failed orders (without the
   signature that authorised each order)".

## Checklist
- [ ] Tests first (fake PostgREST that honours `select`): route e2e per read route, property, guard
- [ ] Read routes: explicit allow-list, no `signature` (orders GET, orders/[id] GET, orders/stats)
- [ ] Client type: `OrderRow.signature` optional, `rowToOrder` fallback
- [ ] Privacy section 6 sentence (shared constant, v1 + v2)
- [ ] Mutation proof (scratch copy)
- [ ] Verify: `scripts/agent-verify.sh --codeql`, `node scripts/gen-claude-state.mjs --check`, lint delta 0
- [ ] Evidence 1-5, push, compare link
