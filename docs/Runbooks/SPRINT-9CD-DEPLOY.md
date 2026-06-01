# Deploy Checklist — Sprint 9C + 9D (joint, ship together)

**Commits:** 9C on-chain chain-aware `c8ca8b1` · P228 Bebop `3d938d4`
**Audit:** APPROVED 0C/0H/0M/0L/2I (2026-05-31) — `Audits/SPRINT-9CD-AUDIT-BRIEF.md`
**Scope of release:** on-chain adapters quote the requested chain (fixes "only Uniswap on Base");
Bebop added as 12th source on Ethereum (1) + Base (8453).

---

## A. Pre-deploy env (set in Vercel PRODUCTION before the build)

> `NEXT_PUBLIC_*` vars are **baked at build time** — set them BEFORE triggering the deploy, not after.

1. **`NEXT_PUBLIC_BASE_RPC_URL` — CRITICAL.** Must hold a real Base RPC. The server-side registry
   uses `process.env.NEXT_PUBLIC_BASE_RPC_URL || ''`; if empty, the 9C on-chain adapters have no
   Base RPC and Uniswap V3 cannot quote on Base — i.e. the original bug returns. This was the
   server-side root cause; do not deploy without it.
2. **`BEBOP_API_KEY`** (server-only) — without it Bebop returns widened **demo-mode** quotes, not
   production pricing. Obtain from Bebop support if not already provisioned.
3. **`BEBOP_SOURCE`** (server-only) — our partner identifier.
4. **`FEE_RECIPIENT` + fee bps** — confirm set; Bebop fee rides on these partner-fee params.
5. Confirm none of the above use a `NEXT_PUBLIC_` prefix except the RPC URL (keys are server-only).

## B. Gate checks (must all be true)

- [ ] Audit APPROVED 0C/0H — yes.
- [ ] `docs/security/AUDIT-TOTAL.md` updated by the Auditor with the 9C/9D verdict.
- [ ] CI green on the deploy commit (lint, typecheck, test = 1307, audit); commits signed.
- [ ] No open C/H elsewhere in `AUDIT-TOTAL.md`.

## C. Deploy

1. Merge to `main` (signed). Confirm branch protection accepts (signed + CI green).
2. Trigger the Vercel production build **after** step A is confirmed.
3. Watch the build log for the env vars being present (no `NEXT_PUBLIC_BASE_RPC_URL` empty warning).

## D. Post-deploy verification (production)

1. `GET /api/quote?...&chainId=8453&debug=sources` (WETH→USDC):
   - [ ] Multiple Base sources respond (KyberSwap, OpenOcean, Velora, **Bebop**, Uniswap V3).
   - [ ] Uniswap V3 now reflects **Base** pricing (cross-check vs the live KyberSwap/OpenOcean
         amount ~2020 USDC/ETH at test time), **not** a mainnet-priced number.
   - [ ] `curve` is absent/clean on Base (no bogus quote).
2. `GET /api/quote?...&chainId=1&debug=sources` (mainnet): unchanged set of sources, Bebop present.
3. **Bebop sanity:** confirm a Bebop quote is firm (not demo-mode) — i.e. the API key is live.
   Resolves INFO #2 (placeholder-taker / demo-mode caveat from FEEDBACK.md).
4. Execute one small real Base swap (or simulation) via a non-Uniswap source to confirm
   end-to-end calldata + approval (Balance Manager for Bebop).

## E. Rollback

- Single Vercel "Promote previous deployment" reverts the frontend/API. The 9C/9D changes are
  quote/adapter-layer only (no contract changes), so rollback is config-free.

## F. Post-deploy housekeeping

- [ ] Update `ops-state` (sprint 9C/9D shipped, date, commit).
- [ ] File the 2 INFO findings into the backlog: (1) Uniswap fee-tier cache key still keyed by
      mainnet `CHAIN_ID` (harmless today — detection re-runs per chain); (2) Bebop placeholder-taker
      live-validation. Neither blocks release.
- [ ] Base Curve pools remain a deferred follow-up (curve returns null off-mainnet by design).
