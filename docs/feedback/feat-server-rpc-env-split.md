# Feedback — feat/server-rpc-env-split

Checklist
- [x] C1 resolver `src/lib/rpc-env.ts` + call sites rewired + env-validation + `.env.example` + `docs/Runbooks/ENV-RPC.md`
- [x] C2 proof tests (set/unset, guard, log line)
- [x] C3 `/api/rpc` per-call rate-limit units
- [ ] Evidence 1–5 below

## Premise deltas (owner may supersede)
- `/api/rpc` **already caps batches at 25** (`MAX_RPC_BATCH_SIZE`, tests exist) — C3 only adds per-call rate-limit units.
- **No `docs/Runbooks/ENV*.md` existed**; created `docs/Runbooks/ENV-RPC.md` (small, RPC-only).
- Existing server name is `RPC_URL` (mainnet only, 3 sites). Kept, ranked after `RPC_URL_1`, never used for Base/Arbitrum.
