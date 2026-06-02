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

- **Code:** PR #116 (9CD, `40ddde2`) → caused 502 → rolled back → fixed PR #117 (`9d72f4b`) →
  final release PR #118 (`hotfix/quote-route-502`) **MERGED**. (9F test+docs `adc2e55` committed,
  not yet pushed — rides the next PR.)
- **Deploy:** ✅ **LIVE + verified in production** — Vercel `adc4188` on `main` (2026-06-02).
  User-verified: Base multi-source Compare + gas/fee USD (parity w/ mainnet), Base swaps execute.
  **Base arc CONCLUDED.** Runbook: `docs/Runbooks/SPRINT-9CD-DEPLOY.md`.

## Tomorrow / next session (carry-over)
1. **Alchemy key allowlist** — enable referrer/domain allowlist on the `teraswap-mainnet-v2` app
   (`NEXT_PUBLIC_BASE_RPC_URL` is client-exposed; "Sensitive" in Vercel does NOT hide it).
2. **Contract verification on Basescan** (`forge verify` failed — sync OZ submodule + match deploy
   compiler settings; use Etherscan V2 key, `--chain base`).
3. **Push the bundled PR** (9F `adc2e55` + the 5 docs) to `main`.
4. Review the Code Agent's autonomous 9F-backlog cleanup (no-route vs failure convention) — commits
   on branch, not merged.
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
