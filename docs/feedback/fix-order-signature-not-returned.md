# fix/order-signature-not-returned (S-13 of the PR #689 audit; Draft PR, Auditor required)

No read response returns the order's EIP-712 `signature`, with or without a read signature; order reads select an
explicit allow-list. Long tables: [`fix-order-signature-not-returned.tables.md`](fix-order-signature-not-returned.tables.md).

## Owner answers (asked once, 2026-11-17; they supersede the goal text)
1. Drop `signature` from authenticated reads too. Client type made honest: `OrderRow.signature?`, `rowToOrder` → `''`.
2. Allow-list = the browser's `OrderRow` columns minus `signature` (30); on Postgres 42703 retry once without `floor_tier`, `floor_ack_at` (migration 20261011120000).
3. POST 201 echo of the caller's own just-verified signature (route.ts:760): POST untouched, SAFE.
4. Privacy section 6 clause: "the records of its executed, cancelled, expired or failed orders (without the signature that authorised each order)".

## Evidence
1. **Read paths** (tables E1). GET /api/orders and GET /api/orders/[id]: `*` → allow-list (order-read-columns.ts), auth unchanged (terminal public, live needs the read signature). Stats: `select('*', head)` → `select('id', head)`, counts only either way. Executions, history fills, analytics: already named columns, unchanged. POST / PATCH untouched.
2. **Does the browser need it? No.** Its only reader was `rowToOrder` (useOrderEngine.ts:313), and nothing reads `AutonomousOrder.signature`. Cancel uses `id / order_hash / status` (lib/order-engine/supabase.ts:224-235), the stored struct `order.order` (useOrderEngine.ts:410-411) and a fresh CancelOrder signature (:1238, :1326). OrderDashboard, OrderCancelReviewModal, WalletHistory and v2 OrdersTab, DcaCancelSheet, use-wallet-history read no `signature`.
3. **Hunt** (table E3). CLOSED: order read routes. SAFE: stats, executions, history, analytics, POST echo, PATCH, error bodies, server logs, src alerts, admin page (client-side check only, renders /api/analytics) and admin API (bearer secrets), Realtime (no subscriber), RLS as written (anon JWT has neither `wallet_address` nor `sub`: no row; live project NOT verified). INHERENT: keeper eth_call / calldata (executor.js:1620, :2017). **OPEN, keeper, reported not changed:** executor.js:2156 logs and executor.js:2161 → monitor.js:62 sends to Telegram `redactError(err)`, which redacts URLs only; a viem contract error carries `args:` with the signature (measured with a dummy value).
4. **Tests** (table E4): 41 route e2e + 10 property (seeds 1, 7, 42, 1117, 20261117; 800 cases) + 4 guard = 55, all red on the base code where it leaked (25 + 10 + 2), green now. Mutation proof: signature back in the list select → 25 fail, by-id select → 22, the allow-list → 36, stats `*` → 2 (guard). Existing order list / history tests, v1 and v2: 61 files, 1011 tests green, unchanged.
5. **Verify** at code head 9eb7e00f (base origin/main 4a4129ef): `scripts/agent-verify.sh --codeql` RESULT PASS: suite 10906 passed / 0 failed (510 files), lint delta errors +0 warnings +0, tsc 0, build ok, v1v2-parity 123, rpc-budget 36, CodeQL security-extended head 13 / base 13, 0 new. `node scripts/gen-claude-state.mjs --check`: current. gitleaks on each staged commit: no leaks. diff --stat origin/main...9eb7e00f: 14 files, +1235 / -30 (incl. the first version of this file); the evidence commit after it changes only docs/feedback. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/order-signature-not-returned. **Not verified:** the live Supabase project (RLS, grants, Realtime publication, whether 20261011120000 is applied; the retry covers both states), PostgREST's real 42703 answer (the fake models it), the Orders tab in a browser (unit tests + build only), the keeper OPEN exits with a real revert (measured on a constructed viem error); `--keeper` not run (keeper untouched).

## Feedback
- Edge case: `GET /api/orders?status=<terminal>&hashes=…` is a public by-hash read (no read signature); covered by the tests.
- Concern: guard layer 2 accepts a non-literal `select(x)` in a file importing order-read-columns.ts; layer 1 checks the value.
- Concern (keeper, OPEN above): log and alert `err.shortMessage`, or strip `args:`, in a keeper goal.
- Assumption checked: the goal named supabase/schema.sql for the `orders` RLS; it has none. The policies are in contracts/order-engine/schema.sql:175-217 and supabase/improvements.sql:17-40.
- Merge note: route.ts gains one import line at the top (for GET) besides the GET body; POST is untouched, but the open POST branch may meet a one-line conflict in the import block.
