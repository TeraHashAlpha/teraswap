# SPRINT-47-ARBITRUM-ACTIVATION-PREP — router re-verification + activation plumbing + FeeCollector deploy runbook (42161)

> **Source:** Sprint 46 shipped dark (merged #300) with an explicit activation checklist in its FEEDBACK:
> (1) 1inch + OpenOcean router addresses on 42161 assumed cross-chain-deterministic, NOT explicitly re-verified;
> (2) the readiness report labels `0xE592427A…` "SwapRouter02" but that address is the ORIGINAL Uniswap SwapRouter
> (V1) — resolve before anything is whitelisted; (3) FeeCollector deploy + env + joint audit. This sprint closes
> the checklist and produces everything the owner needs to deploy + activate — **the Code Agent deploys NOTHING
> and flips NO env.** Fund-flow-adjacent (router whitelist + FeeCollector path) → **Auditor-gated: PR UNMERGED
> until the JOINT 46+47 pass returns 0C/0H** (the 9C+9D pattern; Sprint 46 carried only an Auditor note).
> Order-engine/DCA on 42161 stays fail-closed — v3 orders on Arbitrum are a later sprint, after v3 proves on Base.
> SSH-signed; branch `sprint/47-arbitrum-activation-prep` off latest `origin/main` in a dedicated worktree;
> 4 droppable commits. Parallel-safe with `sprint/v3-p4-deploy` (disjoint files; do NOT touch
> `docs/Runbooks/V3-EXECUTOR-DEPLOY.md` or `contracts/order-engine/script/**`).

## Requirements (per-commit)

### 1. On-chain router re-verification (closes Sprint-46 checklist items 1–2)
Verify against a public Arbitrum RPC + Arbiscan, and record method + result per address in a new
`docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md`:
- **Velora/Augustus V6.2** — re-confirm bytecode at the canonical address (recon verified it; re-check, cite).
- **1inch v6 router** and **OpenOcean router** on 42161 — resolve each from its OFFICIAL source (docs/API
  deployments endpoint), confirm on-chain code, compare with what the adapters actually send through `/api/swap`.
- **UniswapV3:** resolve the SwapRouter (V1) vs **SwapRouter02** discrepancy — identify which one the Uniswap
  adapter's execution path actually targets on mainnet/Base today, pick the SAME semantic contract for 42161,
  and fix the 42161 config entry if the recon value was wrong (this is the correction commit — cite both
  addresses in the report).
- Any mismatch found = fix the config value in this commit + flag prominently in FEEDBACK.

### 2. Activation plumbing (Base Sprint-44/45 pattern)
- Switch `CHAIN_CONFIGS[42161].contracts.feeCollector` from hard-null to **env-driven with null default**
  (`NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR`, unset ⇒ exactly today's dark behavior — regression-tested).
- Port the Sprint-45 activation guards to 42161: per-chain spender resolution, simulation path, fee-USD
  accounting, quote gating — all keyed off the env-driven address, all fail-closed when unset.
- Order-engine isolation re-asserted: activating swaps on 42161 must NOT expose orders/DCA (executor null,
  `isDcaLive` pinned 8453 — extend the Sprint-46 regression tests to the activated state).

### 3. `docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md` (adapt the Base runbook)
Pre-flight (joint 46+47 audit 0C/0H recorded; router verification report accepted) → deploy FeeCollector V2
source on 42161 (Foundry, params by env NAME: treasury/owner, router whitelist = the report-verified V6.2 —
taken as input and CHECKED, never embedded) → Arbiscan source verification (+ the BaseScan-mislabel precedent
check) → read-only post-deploy verifier checklist (owner, whitelist-exact, fee bps) → **Preview gate:** flip env
in Vercel Preview only; e2e smoke = quote quorum across the 12 adapters, one small real swap, fee collection
verified on-chain, source-health baselines for 42161 → prod flip → rollback (unset env ⇒ dark again) → Alchemy
allowlist + monitoring steps (mirror the Base manual-actions list).

### 4. Tests
Env-driven activation (unset ⇒ dark, set ⇒ active) regression both ways; guard ports; order-engine isolation
under activated state; router-config correction covered; runbook lint/link check if CI has one.

## Do NOT
Deploy anything; flip any env; touch order-engine/DCA gates beyond assert-tests; touch v3-P4 files
(`docs/Runbooks/V3-EXECUTOR-DEPLOY.md`, `contracts/order-engine/script/**`) — a parallel session owns them;
change mainnet/Base behavior; no secrets.

## Files affected (read ONLY these + new)
`src/lib/chains/**`, adapter/router config, activation-guard modules + tests, **new**
`docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md` + `docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md` +
`docs/Prompts/SPRINT-47-ARBITRUM-ACTIVATION-PREP.md` (commit this spec), `.env.example` (names only).
Read-only: `docs/Reports/ARBITRUM-READINESS.md`, Base runbooks, FeeCollector sources, Sprint-45 spec.

## Expected output
Branch + PR, CI green (push + report, don't poll). FEEDBACK ≤1 screen: per-router verification verdicts (esp.
the SwapRouter02 resolution — state which address and WHY), any config corrections made, runbook step list.
**Flag for the joint 46+47 Auditor pass — do NOT merge.**

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the listed files · FEEDBACK <= 1 screen.

SPRINT-47-ARBITRUM-ACTIVATION-PREP per docs/Prompts/SPRINT-47-ARBITRUM-ACTIVATION-PREP.md (commit the spec in this PR). Branch sprint/47-arbitrum-activation-prep off origin/main in a DEDICATED worktree, SSH-signed, CI green. FUND-FLOW-ADJACENT (router whitelist + FeeCollector path) -> Auditor-gated: PR UNMERGED until the JOINT Sprint 46+47 pass returns 0C/0H. Deploy NOTHING, flip NO env. Do NOT touch docs/Runbooks/V3-EXECUTOR-DEPLOY.md or contracts/order-engine/script/** (parallel v3-P4 session owns them). Order-engine/DCA on 42161 stays fail-closed (v3-on-Arbitrum is a later sprint).

Commits (droppable, in order):
1. On-chain router re-verification (closes the Sprint-46 FEEDBACK checklist) -> new docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md (method + result per address, public Arbitrum RPC + Arbiscan): re-confirm Velora/Augustus V6.2 bytecode; resolve 1inch v6 + OpenOcean routers on 42161 from their OFFICIAL deployment sources and confirm on-chain code vs what the adapters send; resolve the UniswapV3 discrepancy — 0xE592427A… is the ORIGINAL SwapRouter (V1), not SwapRouter02: identify which semantic contract our adapter's execution path targets on mainnet/Base today, pick the SAME for 42161, and FIX the 42161 config if the recon value was wrong (cite both addresses). Any mismatch = fix config in this commit + flag in FEEDBACK.
2. Activation plumbing (Base 44/45 pattern): CHAIN_CONFIGS[42161].contracts.feeCollector hard-null -> env-driven NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR with null default (unset == today's dark behavior, regression-tested). Port Sprint-45 activation guards to 42161: per-chain spender, simulation, fee-USD, quote gating — all fail-closed when unset. Re-assert order-engine isolation under the ACTIVATED state (executor null, isDcaLive pinned 8453 — extend the Sprint-46 regression tests).
3. docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md (adapt the Base runbook): pre-flight (joint audit 0C/0H recorded; router report accepted) -> deploy FeeCollector V2 source on 42161 (Foundry, params by env NAME; router whitelist = report-verified V6.2, taken as INPUT and CHECKED, never embedded) -> Arbiscan verification + the BaseScan-mislabel precedent check -> read-only post-deploy verifier checklist (owner, whitelist-exact, fee bps) -> PREVIEW GATE: env flip in Vercel Preview only; e2e smoke = quote quorum across the 12 adapters, one small real swap, on-chain fee collection verified, source-health baselines for 42161 -> prod flip -> rollback (unset env => dark) -> Alchemy allowlist + monitoring (mirror the Base manual-actions list).
4. Tests: env-driven activation both ways; guard ports; order-engine isolation while activated; router-config correction covered.

Do NOT: deploy; flip envs; touch order/DCA gates beyond assert-tests; touch v3-P4 files; change mainnet/Base behavior; secrets.

Files: src/lib/chains/**, adapter/router config, activation-guard modules + tests, NEW docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md + docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md + docs/Prompts/SPRINT-47-ARBITRUM-ACTIVATION-PREP.md, .env.example (names only). Read-only: docs/Reports/ARBITRUM-READINESS.md, Base runbooks, FeeCollector sources, SPRINT-45 spec.

Expected: PR open, CI green (push + report). FEEDBACK <=1 screen: per-router verdicts (esp. the SwapRouter02 resolution — which address and WHY), config corrections, runbook step list. Flag for the JOINT 46+47 Auditor pass — do NOT merge.
```
