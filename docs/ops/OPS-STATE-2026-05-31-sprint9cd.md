# Ops-State — Sprint 9C/9D (Base sources + Bebop)

**Date:** 2026-05-31
**Owner:** Architect (record) · TeraHash (deploy)

---

## Release contents

| Sprint | Commit | What | Audit |
| --- | --- | --- | --- |
| 9C | `c8ca8b1` | uniswapv3 + curve chain-aware — no mainnet-priced quote on Base | APPROVED |
| 9D / P228 | `3d938d4` | Bebop = 12th source (Ethereum 1 + Base 8453), JAM API | APPROVED |
| diag | `98e9df0` | admin-gated `debug=sources` diagnostic | — |
| base | `64e68ca` | accept any active chain in swap flow checks | — |

**Joint audit verdict (2026-05-31):** APPROVED — **0C / 0H / 0M / 0L / 2 INFO**. 1307 tests green,
signed commits. Brief: `Audits/SPRINT-9CD-AUDIT-BRIEF.md`.

## State machine

- **Code:** PR #116 (`release/sprint-9cd-base-sources` → `main`) **MERGED**.
- **Deploy:** **LIVE in production** — Vercel build `40ddde2` on `main` (Ready · Production,
  2026-05-31). Runbook: `docs/Runbooks/SPRINT-9CD-DEPLOY.md`. Post-deploy verification PENDING.
- **Sources:** 12 total (was 11). Bebop live on chains 1 + 8453. Curve returns null off-mainnet.

## Env (Vercel production)

- [x] `NEXT_PUBLIC_BASE_RPC_URL` = Alchemy Base mainnet (app `teraswap-mainnet-v2`, Base enabled),
      set Sensitive in Vercel. NOTE: Vercel "Sensitive" only hides it in the Vercel dashboard — a
      `NEXT_PUBLIC_` var is still inlined into the client bundle, so the key IS publicly visible.
      **TODO (security): enable Alchemy referrer/domain allowlist** (teraswap.app + preview). Robust
      follow-up: proxy Base RPC via the existing `/api/rpc` so the key never reaches the client.
- [ ] `BEBOP_API_KEY` (server-only) — confirm set, else Bebop runs demo-mode (widened quotes).
- [ ] `BEBOP_SOURCE` (server-only) — partner id.
- [ ] `FEE_RECIPIENT` + fee bps — confirm present (Bebop partner-fee rides on these).

## Post-deploy verification (pending)

- [ ] `/api/quote?...&chainId=8453&debug=sources`: multiple Base sources incl. Bebop; Uniswap V3
      shows **Base** pricing (not mainnet); curve absent.
- [ ] `chainId=1` unchanged + Bebop present.
- [ ] Bebop quote is firm (not demo-mode) → resolves INFO #2.
- [ ] One small Base swap via a non-Uniswap source (approval → Balance Manager for Bebop).

## Backlog (from audit INFO + FEEDBACK)

- INFO-1: Uniswap fee-tier cache key still keyed by mainnet `CHAIN_ID` (harmless — re-runs per chain).
- INFO-2: Bebop placeholder-taker live validation (covered by post-deploy check above).
- Deferred: Base Curve pools (curve null off-mainnet by design).

## Health stack / kill-switch

- No contract changes in this release → kill-switch + H1–H6 monitoring unaffected. Rollback =
  Vercel "Promote previous deployment" (config-free).
