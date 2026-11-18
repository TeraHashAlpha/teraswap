# fix/order-signature-not-returned: evidence tables

Companion to [`fix-order-signature-not-returned.md`](fix-order-signature-not-returned.md). Line numbers are at 091bc08f (round 2, after merging origin/main into 99678b33); every one was re-checked there for A87 S-3. A reference marked "at base" is to origin/main 4a4129ef, the code before this branch.

## E1. Every read of `orders`: route, auth, columns before and after

`*` = all 43 columns of `orders`: the 42 of CREATE TABLE (contracts/order-engine/schema.sql:18-106) plus `basket_id` (`ALTER TABLE orders ADD COLUMN`, schema.sql:451, PR #707), `signature` included. "Allow-list" =
`ORDER_READ_COLUMNS` in src/app/api/orders/order-read-columns.ts (30 columns: the browser's `OrderRow` minus
`signature`; the other 13 columns are withheld: `signature` and 12 no page reads, `updated_at`, `price_condition`, `current_price`,
`dca_last_exec`, `fee_amount`, `gas_used`, `executed_price`, `consecutive_failures`, `last_attempt_at`, `last_infra_miss_at`,
`last_infra_miss_reason`, `basket_id`), retried once without `floor_tier`, `floor_ack_at` on Postgres 42703 / PGRST204.

| Route (handler) | Auth | `orders` columns before | After |
|---|---|---|---|
| GET /api/orders (route.ts:811) | none when every `status` is terminal (also with `hashes`); read signature otherwise (route.ts:844-861) | `*` (route.ts:835-836 at base) | allow-list (route.ts:870-885) |
| GET /api/orders/[id] ([id]/route.ts:29) | none when the row is terminal; read signature when live ([id]/route.ts:61-76) | `*` ([id]/route.ts:42-44 at base) | allow-list ([id]/route.ts:45-52) |
| GET /api/orders/stats (stats/route.ts:18) | none | `select('*', { head: true })`: counts only, no row | `select('id', { head: true })`, same counts (stats/route.ts:32) |
| GET /api/orders/[id]/executions | `wallet` param only | 13 named columns, no `signature` (executions/route.ts:42-44) | unchanged |
| GET /api/history | swaps public; fills need the read signature (history/route.ts:106-115) | embed `orders!inner(` 9 columns (history/route.ts:247-249) | unchanged |
| GET /api/analytics | none | embed `orders(` 10 columns (analytics/route.ts:84) | unchanged |
| POST /api/orders 201 (not a read) | the order's own EIP-712 signature, recovered == wallet | `.insert(...).select()` = every column (route.ts:755-792), echoed at route.ts:803 | unchanged (Do-NOT; owner: SAFE, it echoes the caller's own submission) |
| PATCH /api/orders/[id] (not a read) | CancelOrder signature | `select('id')`, probe `wallet, status, chain_id` ([id]/route.ts:148-166) | unchanged |
| src/lib/keeper-health-monitor.ts:142-146, :255-256 | server only, no response body | `created_at, executed_at, dca_interval`; `id` count | unchanged |
| src/lib/monitoring-loop.ts:390 | server only (keepalive) | `id` | unchanged |
| keeper fetchActiveOrders (executor.js:671) | service role, own process | `select=*` | not changed (keeper; it needs `signature` to execute) |

## E3. The hunt: every exit of `orders.signature`

| Exit | Where | Verdict |
|---|---|---|
| Order read routes | route.ts GET, [id]/route.ts GET | CLOSED by this branch (allow-list, both auth modes) |
| Stats | stats/route.ts:32 | SAFE before (head-only counts), now named column |
| Executions, history fills, analytics feed | executions/route.ts:42-44, history/route.ts:247-249, analytics/route.ts:84 | SAFE (named columns, no `signature`; pinned by the new tests) |
| POST 201 echo | route.ts:791, :803 | SAFE (owner 2026-11-17): returns only the signature the caller just sent and the route verified |
| PATCH and its errors | [id]/route.ts:148-186 | SAFE (`id` / `wallet, status, chain_id`; messages name status or chain only) |
| Errors returned to the client | route.ts:800 (POST insert error), :886 (GET), [id]/route.ts:157 | SAFE: PostgREST `message` names the column or constraint, not row values (`details` is not returned); POST's is the caller's own row |
| Other API routes | analytics/export (swaps only), analytics/personal (no DB), portfolio, v1, cow, admin/* | SAFE: no other `from('orders')` or `orders(` in src/app/api (guard layer 2 scans all of src/) |
| Reference file contracts/order-engine/api/orders.ts | its own header: "reference implementation", not under src/app | SAFE: not served |
| Admin page | src/app/admin/page.tsx:9-25: client-side check of the connected address against `NEXT_PUBLIC_ADMIN_WALLET`, no signature, no server check | SAFE for `signature`: renders AdminMonitor, which reads only /api/analytics (useAnalytics). Note: the gate is cosmetic (the bundle and /api/analytics are public anyway) |
| Admin API routes | admin/api-keys:44-46, dca-freeze:39-47, kill-switch:135-144, ui-version:29: bearer token vs a server secret (verifyBearerToken) | SAFE: none reads `orders` |
| Direct reads with the public anon key (RLS) | contracts/order-engine/schema.sql:182-186 (SELECT for every role: `wallet = lower(jwt.claims->>'wallet_address')`), supabase/improvements.sql:36-40 (`TO anon`: `wallet = jwt.claims->>'sub'`) | SAFE AS WRITTEN: the anon key's JWT carries neither claim, so both compare to NULL and return no row; no other wallet's JWT is ever issued. NOT VERIFIED against the live project (dashboard edits, grants, a custom-claims hook). No column privilege protects `signature` if a policy ever matched (REPORTED, RLS not changed) |
| Realtime | no subscriber in src (`postgres_changes` / `.channel(`: 0 hits; src/lib/order-engine/supabase.ts:6-11 records its removal) | SAFE in code; Realtime applies the same RLS. Whether `orders` is in the `supabase_realtime` publication is not in the repo: NOT VERIFIED |
| Server logs (src) | history/route.ts:94, :128, :257, :262; analytics/route.ts:45, :63, :91, :96 | SAFE: `error.message` / error objects only, never a row |
| Alerts from src (Telegram, Discord, email) | keeper-health-monitor.ts, monitoring-loop.ts, alert-wrapper.ts, monitor routes | SAFE: the only `orders` reads there select `created_at, executed_at, dca_interval` / `id`; no alert carries a row |
| `orders.error` / `last_infra_miss_reason` text | keeper writes reason codes (retry-policy.js:718) and short labels (retry-policy.js:74) | SAFE: never `err.message` |
| Keeper to RPC provider and chain | executor.js:1620 (`canExecute` eth_call args `[orderStruct, signature]`), executor.js:2017 (`executeOrder` calldata) | INHERENT: execution needs it on-chain; an executed order's signature is public in its calldata; an eth_call shows it to the RPC provider |
| Keeper logs | executor.js:2156 `console.error(..., redactError(err))`; redact.js:197 redacts URLs only | OPEN (keeper, REPORTED): a viem `ContractFunctionExecutionError` for `executeOrder` / `canExecute` puts `args: (…, <signature>, …)` in `err.message`. Measured with a dummy 65-byte value: `err.message` and `redactError(err)` contain it, `err.shortMessage` does not |
| Keeper Telegram alert | executor.js:2161 stores `redactError(err)` in `stats.lastError`; monitor.js:62 sends `Last error: …` after CONSECUTIVE_ERROR_THRESHOLD; alert.js has no length cap | OPEN (keeper / alerts, REPORTED): the same message, signature included, can reach the Telegram chat. Fix idea for a keeper goal: log and alert `err.shortMessage` (or strip `args:`) |
| Keeper /health | executor.js:2268-2300 | SAFE: counters only, no `lastError` |
| Browser storage | useOrderEngine.ts:253-261 (`saveOrders`, encrypted local copy) | SAFE: an order signed in this browser keeps its own signature locally; orders loaded from the server now carry `''` |

## E4. Tests, seeds, mutation proof

| File | Tests | What |
|---|---|---|
| src/app/api/orders/orders-read-no-signature.test.ts | 41 | Real handlers through `fake-postgrest.ts` (honours `select`: `*` returns `signature`). Every DB status, without and with a valid read signature: list, list by hash, by id, stats, executions, history, analytics. Exact key set = allow-list; DB without the floor columns. Leaks reported by path, never by value |
| src/app/api/orders/orders-read-no-signature.property.test.ts | 10 | Seeds 1, 7, 42, 1117, 20261117; 80 cases each, twice (no / wrong-signer / expired / malformed read signature; then a valid one). Random rows (0-12, 3 wallets, 6 statuses, fills, swaps, 25 % without floor columns) and queries (`status` single, list, unknown, empty, wrong case; `hashes` known, unknown, duplicated; mixed). 800 cases |
| src/app/api/orders/orders-read-select-guard.test.ts | 7 | Layer 1: every `orders` select (and `orders(` embed) sent by the read paths WITHOUT a read signature and WITH one (poll by hash, live statuses, by id, history fills) is explicit. Layer 2: a scan of every `.from(<table>)` read chain in src/ (table resolved through a `const`) and every `orders(` embed; a non-literal select passes only as the columns parameter of `withOrderReadColumns`. Each checker is first shown to fail on `*` and on the four evasions below |

Before the fix (base code, same tests): 25 of 41 route tests, 10 of 10 property seeds and 2 of 4 guard tests failed
(at base, the guard named route.ts:835, [id]/route.ts:43 and stats/route.ts:30 as `select('*')`).

Mutation proof (detached scratch worktree at the branch head, one mutant at a time, file restored after each):

| Mutant | Change | Result |
|---|---|---|
| M1 | route.ts `.select(columns)` → `.select(columns + ',signature')` | 25 failed / 55: guard layer 1, 14 list route tests, 10 property seeds |
| M2 | [id]/route.ts, the same change | 22 failed / 55: guard layer 1, 11 by-id tests, 10 property seeds |
| M3 | `'signature'` added to ORDER_READ_COLUMNS | 36 failed / 55 |
| M4 | stats/route.ts back to `select('*', { head: true })` | 2 failed / 55: guard layers 1 and 2 |

Round 1 limit (A87 S-5, closed in round 2): layer 2 accepted any non-literal `select(x)` in a file that imports
order-read-columns.ts and skipped `.from(<variable>)`; layer 1 drove only unauthenticated reads. Still open: a chain broken
across statements (`const q = supabase.from('orders'); q.select('*')`) has no `.select` call directly on `.from(...)`, so layer 2
sees no select there; layer 1 catches it only on a path the test runs.

### Failing tests per mutant (pasted from the scratch run, vitest `FAIL` lines, file > describe > test)

**M1-list-select** (25 failed):

```
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 7: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 42: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1117: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 20261117: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 7: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 42: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1117: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 20261117: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=executed without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=cancelled without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=expired without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=failed without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > every terminal status at once, without a read signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > by hash with a terminal status filter (the one public by-hash shape), without a read signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=active WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=executing WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=executed WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=cancelled WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=expired WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=failed WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > no status filter and the by-hash poll, WITH a valid read signature: every own order, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > a database without the floor-tier columns (migration not applied): still every row, no signature
orders-read-select-guard.test.ts > guard, layer 1: the unauthenticated read paths select an explicit orders column list > every orders select of every unauthenticated read path is explicit
```

**M2-by-id-select** (22 failed):

```
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 7: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 42: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1117: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 20261117: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 7: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 42: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1117: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 20261117: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a executed order without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a cancelled order without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a expired order without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a failed order without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a active order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a executing order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a executed order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a cancelled order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a expired order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a failed order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a database without the floor-tier columns: the row, no signature
orders-read-select-guard.test.ts > guard, layer 1: the unauthenticated read paths select an explicit orders column list > every orders select of every unauthenticated read path is explicit
```

**M3-allow-list** (36 failed):

```
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 7: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 42: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1117: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 20261117: random tables and queries, no or invalid read signature
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 7: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 42: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 1117: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.property.test.ts > property: no stored order signature in any read response > seed 20261117: the same, WITH a valid read signature (dropped there too)
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=executed without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=cancelled without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=expired without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=failed without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > every terminal status at once, without a read signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > by hash with a terminal status filter (the one public by-hash shape), without a read signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=active WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=executing WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=executed WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=cancelled WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=expired WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > status=failed WITH a valid read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > no status filter and the by-hash poll, WITH a valid read signature: every own order, no signature
orders-read-no-signature.test.ts > GET /api/orders: no signature in any response > a database without the floor-tier columns (migration not applied): still every row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a executed order without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a cancelled order without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a expired order without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a failed order without a read signature: the row, allow-listed columns, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a active order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a executing order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a executed order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a cancelled order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a expired order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a failed order WITH a valid read signature: the row, no signature
orders-read-no-signature.test.ts > GET /api/orders/[id]: no signature in any response > a database without the floor-tier columns: the row, no signature
orders-read-select-guard.test.ts > guard, layer 1: the unauthenticated read paths select an explicit orders column list > every orders select of every unauthenticated read path is explicit
```

**M4-stats-star** (2 failed):

```
orders-read-select-guard.test.ts > guard, layer 1: the unauthenticated read paths select an explicit orders column list > every orders select of every unauthenticated read path is explicit
orders-read-select-guard.test.ts > guard, layer 2: no orders read chain in src/ selects * or signature > src/ has no orders read chain selecting * or signature, and no such embed
```

## E5. Round 2: the guard against the Auditor's four evasions (A87 S-5)

Each mutant is a one-line change to the real `src/app/api/orders/route.ts` list read (restored after each run), run against the round 1 guard
(`OLD`, the file at 52503188) and the round 2 guard (`NEW`). "L1" = layer 1 (runtime, fake PostgREST); "L2" = layer 2 (static scan of src/).

| Mutant | OLD guard | NEW guard: which layer catches it |
|---|---|---|
| ternary: `.select(needsOwnershipProof && hashes ? '*' : columns)` (`*` only on the authenticated poll) | 4 passed: MISSED | L1 (the authenticated-reads test) and L2 (select is not the bare columns parameter) |
| `*` in a variable: `const starCols = '*'`, `.select(starCols)` | L1 only (unauthenticated test); L2 passed | L1 (both tests) and L2 (not the columns parameter) |
| spread: `.select(...(['*'] as [string]))` | L1 only; L2 passed | L1 (both tests) and L2 (not the columns parameter) |
| table name in a variable: `const ordersTable = 'orders'`, `.from(ordersTable).select('*')` | L1 only; L2 never saw the chain | L1 (both tests) and L2 (table resolves to `orders`, then `select('*')`) |

L2 alone catches all four without running any route: pinned by `the scanner fails a * in a ternary, a * in a variable, a spread, and a table name in a variable`
(plus `let` table, call table, template table, concatenation, `columns` outside the callback, another identifier, a callback that assigns its parameter).
