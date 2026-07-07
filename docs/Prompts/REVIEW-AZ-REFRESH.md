# REVIEW-AZ-REFRESH — re-run the A-Z codebase review against origin/main + reconcile + RICE (READ-ONLY)

> **Source:** the A-Z read-only review (2026-07-05) is strong but was produced against a working copy on the **DEAD
> branch `docs/inc-2026-06-09` (~294 commits behind origin/main)**, so parts may be stale — several findings overlap
> work landed in the last days. This pass **RE-RUNS the review against `origin/main` HEAD**, **RECONCILES** every prior
> finding (fixed / open / partial), re-scores with **RICE**, tags fund-flow + the CLAUDE.md rule each touches, encodes
> the sequencing constraints, and corrects two mis-frames. Output = one committed, dated review doc we then work from.
> **READ-ONLY: no code / config / on-chain changes.** SSH-signed (noreply committer).

## Context
- The 2026-07-05 review covered: **P0 data-loss** (dead branch + ~26 untracked cadenced audit reports only on local
  disk), frontend monoliths (`useSwap.ts`, `SwapBox.tsx`), server god-module (`api.ts`) + route boilerplate (halt-check
  / IP extraction / 429 variants), contracts+keeper (DEPLOY.md instructs the OLD weak `TeraSwapFeeCollector_flat.sol`;
  ABI/router drift; `setOracleConfig`/`unpause` zero coverage; 0 invariants), CI (full suite never runs; 10 single-file
  guard jobs; `--ignore-scripts=false` for a non-existent Prisma postinstall), repo/docs hygiene (stale
  ARCHITECT-INDEX + CLAUDE.md; taxonomy drift; root clutter), deps.
- **Landed since the review's likely baseline — verify each on origin/main:** #254 (W2 DEPLOYED-SOURCES + guards),
  #255 (W6 API hardening), #257 (cleanup-lows), #259 (OpenOcean units + Balancer disabled), #260 (quote-quorum +
  `source-health-monitor` + `sourceHealthFindings`), #261 (Sushi quote-only + `executable-sources` scoping), #263
  (splitroute chainId). Written-but-maybe-unmerged: **AUDIT-W4** (router single-source + parity).

## Objective
Produce a **refreshed, origin/main-grounded** A-Z review with per-finding reconciliation, RICE scores, fund-flow/rule
tags, evidence per load-bearing claim, and an explicit dependency-ordered plan — so we can action it without
re-litigating staleness. **Change nothing.**

## Requirements
1. **Baseline on origin/main, NOT the dead branch.** `git fetch origin`; run the CODE review against a fresh
   checkout/worktree off **`origin/main` HEAD**; **record the exact audited SHA**. Do NOT review the dead-branch
   working copy for code. (Inspect the local working-copy git state ONLY for the P0 evidence — see 3.)
2. **Reconcile every prior finding** into a table: `id · finding · file:line (on main) · status ∈ {CONFIRMED-open,
   FIXED-on-main (commit/PR), PARTIAL, REFUTED, STALE-branch-artifact} · evidence`. Explicitly resolve the overlaps:
   the `source-monitor` "write-only" claim vs #260 `sourceHealthFindings`; splitroute chain-awareness vs #263; router
   single-source vs W4 (merged?); does **this** `TeraSwapFeeCollector_flat.sol` still lack a ⛔ banner (vs the W2/#254
   banner on the V2_DEPRECATED file?); OpenOcean/Balancer vs #259.
3. **Re-verify the load-bearing claims with commands/evidence** (mark CONFIRMED-reproduced vs INFERRED): test count +
   test-file count; CI job count + which (if any) run the FULL suite; "~294 commits behind" + the exact untracked-report
   list (Daily/Weekly/Monthly/Quarterly) for P0; `setOracleConfig`/`unpause` coverage; EIP-712 declared twice
   (`order-engine/types.ts` + `orders/route.ts`); `.npmrc ignore-scripts=true` vs `npm ci --ignore-scripts=false` +
   confirm NO Prisma postinstall in the lockfile; the 6 divergent stablecoin lists; DEPLOY.md pointing at the weak
   contract; globalLimiter in-memory-per-instance.
4. **RICE-score every CONFIRMED-open finding** (Reach·Impact·Confidence / Effort) and rank — replace the loose
   Valor/Esforço.
5. **Tag each finding:** `fund-flow-adjacent?` (needs Auditor involvement — EIP-712, oracle config, contracts,
   fee/approvals) vs pure hygiene; and the **CLAUDE.md rule** it touches (#2/#3/#4/#7/#9/#10/#12) where relevant.
6. **Encode dependencies/sequencing** explicitly, incl.: the single `npm test` CI job (split CI-runnable unit vs
   live-key/RPC integration) **MUST precede** the `useSwap`/`SwapBox` money-path refactor; the DEPLOY.md banner fix
   should **extend `deployed-sources-guard`**; the docs refresh (CLAUDE.md/ARCHITECT-INDEX) + a rule-#4 `archive/`
   convention are Architect-owned.
7. **Correct the two v1 mis-frames:** the parked Limit/Conditional panels are **L2-parked, not "experimental"** (name a
   folder accordingly, e.g. `parked-l2/`); the Zustand `persist` for history/approvals is **non-sensitive → plain
   localStorage** (respect the W9-L-01 boundary — no secure-storage needed).

## Do NOT
- No code / config changes, no on-chain calls beyond read-only views. Don't fix anything — this is a refreshed REVIEW.
- Don't review the dead-branch working copy for code (only for the P0 git-state evidence). Don't overwrite the
  2026-07-05 review (rule #4) — write a **new dated file**.

## Files / areas
- The whole repo on **origin/main HEAD** (read-only) + the local working-copy git state (P0 only) + the recent PRs
  #254/#255/#257/#259/#260/#261/#263 and the AUDIT-W4 prompt, for reconciliation.

## Expected output
- A new dated review committed (SSH-signed) at e.g. `Audits/Reviews/AZ-REVIEW-2026-07-06.md`, **superseding (not
  overwriting)** the 2026-07-05 pass, containing: the audited origin/main SHA; the reconciliation table (v1 finding →
  status on main + evidence); the re-verified claims (CONFIRMED vs INFERRED); the RICE-ranked open-finding table with
  fund-flow + rule tags; the dependency-ordered action plan; and a short "what changed vs v1" note. FEEDBACK: which v1
  findings were already fixed-on-main + any NEW finding surfaced at HEAD.

## Quality criteria
Grounded on a recorded origin/main SHA (not the dead branch); every prior finding reconciled with evidence + a merged
commit where fixed; load-bearing claims reproduced (not inferred); RICE ranking + fund-flow/rule tags present;
sequencing/dependencies explicit; the two v1 mis-frames corrected; **nothing changed** in the codebase.

---

### `/goal` paste for the Code Agent (≤4000)
```
REVIEW-AZ-REFRESH per docs/Prompts/REVIEW-AZ-REFRESH.md. READ-ONLY — no code/
config/on-chain changes. Branch off origin/main, SSH-signed (noreply committer);
commit ONE new dated review doc.

Why: the 2026-07-05 A-Z review is strong but was run against the working copy on
the DEAD branch docs/inc-2026-06-09 (~294 commits behind origin/main), so parts may
be stale — several findings overlap work landed in the last days. Re-run vs
origin/main + reconcile.

Do:
1. Baseline on origin/main, NOT the dead branch: git fetch origin; review a fresh
   checkout/worktree off origin/main HEAD; RECORD the audited SHA. Inspect the local
   working-copy git state ONLY for the P0 evidence.
2. Reconcile EVERY prior finding into a table: id · finding · file:line(on main) ·
   status {CONFIRMED-open / FIXED-on-main(commit/PR) / PARTIAL / REFUTED /
   STALE-branch-artifact} · evidence. Resolve the overlaps: source-monitor
   "write-only" vs #260 sourceHealthFindings; splitroute chain-awareness vs #263;
   router single-source vs W4 (merged?); does THIS TeraSwapFeeCollector_flat.sol
   still lack a banner (vs W2/#254 on the V2_DEPRECATED file); OpenOcean/Balancer
   vs #259.
3. Re-verify load-bearing claims with commands (CONFIRMED-reproduced vs INFERRED):
   test count + test-file count; CI jobs + which run the FULL suite; ~294-behind +
   the exact untracked cadenced-report list (P0); setOracleConfig/unpause coverage;
   EIP-712 declared twice (order-engine/types.ts + orders/route.ts); .npmrc
   ignore-scripts vs npm ci --ignore-scripts=false + confirm NO Prisma postinstall
   in the lockfile; the 6 divergent stablecoin lists; DEPLOY.md pointing at the weak
   contract; globalLimiter in-memory-per-instance.
4. RICE-score every CONFIRMED-open finding (Reach·Impact·Confidence/Effort) + rank.
5. Tag each: fund-flow-adjacent? (needs Auditor — EIP-712, oracle config, contracts,
   fee/approvals) vs hygiene; + the CLAUDE.md rule it touches (#2/#3/#4/#7/#9/#10/#12).
6. Encode sequencing: the single `npm test` CI job (split CI-runnable unit vs
   live-key/RPC integration) MUST precede the useSwap/SwapBox money-path refactor;
   the DEPLOY.md banner fix extends deployed-sources-guard; docs refresh + rule-#4
   archive/ convention are Architect-owned.
7. Correct two v1 mis-frames: parked Limit/Conditional panels = L2-parked NOT
   "experimental"; Zustand persist for history/approvals = non-sensitive -> plain
   localStorage (W9-L-01 boundary, no secure-storage).

Do NOT: change any code/config; review the dead-branch working copy for code (only
for P0 git-state); overwrite the 2026-07-05 review (rule #4 — new dated file).

Deliver Audits/Reviews/AZ-REVIEW-2026-07-06.md (SSH-signed), superseding not
overwriting: audited SHA; reconciliation table; re-verified claims (CONFIRMED vs
INFERRED); RICE-ranked open-finding table w/ fund-flow + rule tags; dependency-
ordered plan; "what changed vs v1". FEEDBACK: which v1 findings were already fixed
on main + any NEW finding at HEAD.
```
