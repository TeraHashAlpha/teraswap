# fix/executor-alert-masking-rpc-auth — feedback (INC-2026-10-30-001)

Base: origin/main `ebaf0be`. Auditor-note: keeper code — owner opens the PR as DRAFT.

## Checklist
- [x] C1 `redact.js` (redactUrl/redactError) on every alert + log path; keyed-URL alert test; console guard test
- [ ] C2 RPC auth = FATAL-OPS: boot `rpc: AUTH REJECTED …` + high alert; runtime 3 → one rate-limited alert + `paused: rpc-auth`
- [ ] C3 `INC-2026-10-30-001.md` + read-only impact SQL + runbook "changing an RPC key"
- [ ] Keeper + full suite vs origin/main, lint delta 0, tsc clean, pushed, compare link

## Owner answers (in-session, supersede the goal text)
- Orders schema is not in `supabase/migrations` (ALTERs only) → owner: read `contracts/order-engine/schema.sql`
  orders block. Done; SQL uses its real columns.
- `paused` placement → owner: grep consumers first. Result: nothing reads keeper `/health`; daily report reads
  the web `/api/health` + on-chain keeper balance; `keeper_runtime_config` is read only by `/api/dca-floor-cap`.
  The keeper host is SSM-only, so Supabase is the only channel an off-host monitor can read → `paused` goes on
  `/health` + Prometheus + `keeper_runtime_config` (new nullable columns). Monitor/daily-report wiring = follow-up.

## Evidence
1. `alertOps` body, fixture HttpRequestError (same input, origin/main → branch; Status/Details lines unchanged):
   `URL: https://base-mainnet.g.alchemy.com/v2/TESTKEY` → `URL: https://base-mainnet.g.alchemy.com/REDACTED`
2. Guard (`redact.test.mjs`, `REDACT_GUARD_DIR=<origin/main>`): 20 raw-error sinks — alert 1, env 1, event-watcher 2,
   executor 12, monitor 4 (incl. `executor.js:1147` the leaking alert, `:2429` `console.error("Fatal error:", err)`)
   → branch 0. redact suite 21/21.
