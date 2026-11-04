# fix/infra-failures-dont-burn-orders — FEEDBACK (Code Agent; 2026-11-04)

## Checklist
- [x] Worktree `~/ts-worktrees/infra-failures-dont-burn-orders` off origin/main a5cd8fe, real `npm ci` (root + executor), SSH-signed noreply committer
- [x] C1 classify every miss (`classifyMissCause` / `classifySwapApiMiss`, plan carries `cause`), ADR-026 Proposed, index row
- [ ] C2 only `order` misses count; infra ⇒ `last_attempt_at` + `last_infra_miss_*`, order alive; paused ⇒ no attempt; migration (manual)
- [ ] C3 visibility: `/api/monitor/keepers.infraMissOrders24h` + daily report + `/health.infraMisses` + runbook § 8
- [ ] Verify: keeper suite Node 20.20.2 + 22.23.4 (0 cancelled), vitest, lint, tsc, CodeQL 0 new; push + compare link

## 1. Cause table
ADR: `docs/ADR/ADR-026-infra-failures-dont-burn-orders.md` § Decision 1 (the table lives there; one line per site).
infra = paused:rpc-auth · rpc-auth · rpc-transport (5xx/429/timeout/socket/fetch failed) · keeper-gas · receipt-unavailable ·
swap-api:<5xx|429|network|misroute> · keeper-config · unclassified (thrown, no tx sent). order = reverted (mined) ·
revert[:Name|swap-failed] · allowance/balance/nonce codes · no-route[:<4xx>|no-tx-data] · expired · unknown (no evidence, legacy).
Not misses (unchanged, never counted): gas-tier / deviation / quorum-skip / floor-breach / cap-delay / pinned-route-revert /
submission-refused / routing-gap / canExecute=false / lock conflict.

## Judgement calls (owner's answer supersedes)
- `swap-api:misroute` (our API returned calldata for another router) and `keeper-config` are **infra** — nothing the user did.
- A 4xx from `/api/swap` (priceGuard / INVALID_SOURCE / no route) is **order**: the API answered; the pair has no acceptable route.
- `unclassified` (a throw before any tx that no rule recognises) is **infra** by the ambiguity rule — including a keeper bug.
- Per-order RPC auth misses are NOT fed to the rpc-auth monitor (no new origin): the cycle-start balance read is the probe.

## Premises checked
- "reuse rpc-auth.js classification": done (`classifyRpcError` imported into retry-policy.js; a revert saying "not on whitelist" stays order).
- `orders.error` cannot hold the infra reason: `DcaOrdersList.tsx:110` shows any non-null `error` as a failed order ⇒ two new columns.
