# fix/infra-failures-dont-burn-orders — FEEDBACK (Code Agent; 2026-11-04)

## Checklist
- [x] Worktree `~/ts-worktrees/infra-failures-dont-burn-orders` off origin/main a5cd8fe, real `npm ci` (root + executor), SSH-signed noreply committer
- [x] C1 classify every miss (`classifyMissCause` / `classifySwapApiMiss`, plan carries `cause`), ADR-026 Proposed, index row
- [x] C2 only `order` misses count; infra ⇒ `last_attempt_at` + `last_infra_miss_*`, order alive; paused ⇒ no attempt; migration (manual)
- [ ] C3 visibility: `/api/monitor/keepers.infraMissOrders24h` + daily report + `/health.infraMisses` + runbook § 8
- [ ] Verify: keeper suite Node 20.20.2 + 22.23.4 (0 cancelled), vitest, lint, tsc, CodeQL 0 new; push + compare link

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
