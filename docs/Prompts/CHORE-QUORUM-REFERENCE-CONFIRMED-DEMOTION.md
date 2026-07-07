# CHORE-QUORUM-REFERENCE-CONFIRMED-DEMOTION — close NEW2-M-01 (Option 2)

> **Source:** Auditor finding **NEW2-M-01 (MEDIUM, approved-with-tracking)** on PR #272. The #260 low-quorum sanity
> (`applyLowQuorumSanity`, n<3) demotes the winner whenever the **pairwise** spread `(winner−runnerUp)/runnerUp` >500bps
> — **blind to which side lies**. So a source quoting **>5% UNDER an honest winner** griefs the honest winner into
> demotion and shows the attacker's low quote as best (price degradation, **not theft** — on-chain `minimumOutput`
> bounds the fill; the attacker gets no funds). **Auditor + Architect agree Option 2.** Fund-flow-adjacent
> (execution-selection) → **Auditor re-confirm after** to close NEW2-M-01. Branch **AFTER #272 merges**. No
> execution-gate / contract change. SSH-signed (noreply committer).

## Objective
Demote the low-quorum winner **only when an external reference confirms the winner is the outlier**; **fall back to
flag-without-reorder when no reference exists** — closing the attacker-lowball in both regimes while **preserving the
mis-scale (garbage-high) defence**.

## Requirements
1. **Reference-confirmed demotion (referenced pairs).** In `applyLowQuorumSanity` (n<3), when a reference price exists
   for the pair — **reuse the existing plumbing**: the **Chainlink consent-gate feed (#18)** and/or the **DefiLlama
   price (#248)**; do **NOT** build a new oracle/price path — demote the winner **only if the winner deviates from the
   reference beyond the demotion threshold** (the reference confirms the *winner* is the outlier). If the reference
   confirms the winner is within threshold (legit), **do NOT demote — regardless of the pairwise spread.** This
   defeats the attacker-lowball (a deliberately-low quote inflates the pairwise spread, but the reference confirms the
   honest winner is correct → no demotion). A genuinely **mis-scaled / garbage-high winner deviates from the
   reference → still demoted** (the #260 mis-scale defence is preserved).
2. **No-reference fallback (oracle-less AND DefiLlama-less pairs).** Fall back to **flag-without-reorder**: set
   `lowConfidence`, show the winner **as-is**, do **NOT** reorder/demote. An attacker can no longer force a demotion;
   the residual mis-scale risk is bounded by on-chain `minimumOutput` + the **tiered USD limits** (oracle-less >$10k is
   already blocked) + the rendered `lowConfidence` cue.
3. **Determinism + composition.** Keep the sanity running **before** the 3×-median filter (as today — no
   double-demotion); reconcile with #248/#18 (reuse their reference; no conflicting signal); keep the result
   deterministic (preserve the NEW-1 determinism / tie-stability guards).
4. **Tests — update `(a) FLAGGED GAP (Auditor)` (`quote-quorum.test.ts`) to prove the fix:**
   - referenced pair, attacker quotes >5% under an honest winner + the reference confirms the winner → **winner NOT
     demoted** (attack defeated);
   - referenced pair, a genuinely mis-scaled/garbage-high winner that deviates from the reference → **still demoted**;
   - a reference-confirmed *runner-up-is-better* case demotes correctly;
   - **no-reference pair** (oracle-less+DefiLlama-less) → **flag-without-reorder**, no demotion;
   - keep the determinism + tie-stability tests.
5. **Characterization.** Update the `quote-quorum.ts` header to describe reference-confirmed demotion + the
   flag-without-reorder fallback (and that the gates remain the terminal backstop).

## Do NOT
- No change to the execution gates (SC-04 `isKnownSwapSelector`, R1 `validateCallDataRecipient`, on-chain
  `minimumOutput`) or the contracts. Don't build a new oracle/price source (reuse #18/#248). Don't change the
  500bps/deviation thresholds beyond gating demotion behind the reference check. Don't make the `lowConfidence` cue
  alarmist (house style: bold, not coloured-alarm).

## Files affected (verify on main, after #272)
- `quote-quorum.ts` (`applyLowQuorumSanity` + the reference wiring) + `quote-quorum.test.ts`. Read-only: #18 (Chainlink
  consent gate) + #248 (DefiLlama deviation) for the reference plumbing.

## Expected output
- Branch `chore/quorum-reference-confirmed-demotion` off latest `origin/main` (**after #272 merges**); SSH-signed; CI
  green. The FLAGGED-GAP test now shows the attacker-lowball **defeated** on referenced pairs; the mis-scale-high
  winner **still demoted**; the no-reference pair uses **flag-without-reorder**. FEEDBACK: how the reference is sourced
  per pair (Chainlink vs DefiLlama), the residual on no-reference pairs, and an explicit **"ready for Auditor
  re-confirm to close NEW2-M-01"** note.

## Quality criteria
An attacker-lowball can no longer demote an honest winner on a referenced pair; a mis-scaled-high winner is still
demoted; no-reference pairs fall back to flag-without-reorder; execution gates + contracts untouched; deterministic;
NEW2-M-01 closable by the Auditor.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-QUORUM-REFERENCE-CONFIRMED-DEMOTION per docs/Prompts/CHORE-QUORUM-REFERENCE-
CONFIRMED-DEMOTION.md. Branch chore/quorum-reference-confirmed-demotion off latest
origin/main (AFTER #272 merges), SSH-signed (noreply committer), CI green. No
execution-gate / contract change. Fund-flow-adjacent -> flag for Auditor re-confirm
to close NEW2-M-01.

Context: Auditor NEW2-M-01 (MEDIUM) — the #260 low-quorum sanity
(applyLowQuorumSanity, n<3) demotes the winner on a pairwise >500bps spread alone,
blind to which side lies -> a source quoting >5% UNDER an honest winner griefs the
honest winner into demotion (price degradation, NOT theft — minimumOutput bounds
the fill). Auditor + Architect agree Option 2.

Do:
1. Reference-confirmed demotion (referenced pairs): in applyLowQuorumSanity, when a
   reference price exists — REUSE the Chainlink consent-gate feed (#18) and/or the
   DefiLlama price (#248); do NOT build a new oracle path — demote the winner ONLY
   if the winner deviates from the reference beyond the threshold (reference
   confirms the WINNER is the outlier). If the reference confirms the winner is
   legit, do NOT demote regardless of the pairwise spread (defeats the
   attacker-lowball). A mis-scaled/garbage-high winner deviates from the reference
   -> STILL demoted (preserve the #260 mis-scale defence).
2. No-reference fallback (oracle-less AND DefiLlama-less pairs): flag-without-
   reorder — set lowConfidence, show the winner as-is, do NOT demote. Residual
   bounded by minimumOutput + tiered USD limits (oracle-less >$10k already blocked)
   + the cue.
3. Keep the sanity BEFORE the 3x-median filter (no double-demotion); reconcile with
   #248/#18; keep it deterministic (NEW-1 guards).
4. Update (a) FLAGGED GAP (Auditor) in quote-quorum.test.ts: referenced pair +
   attacker <5% under honest + reference confirms winner -> winner NOT demoted;
   mis-scaled-high winner deviating from reference -> STILL demoted; a
   reference-confirmed runner-up-better case demotes; no-reference pair ->
   flag-without-reorder (no demotion); keep determinism/tie-stability tests.
5. Update the quote-quorum.ts header to describe reference-confirmed demotion + the
   fallback (gates remain the terminal backstop).

Do NOT: touch SC-04/R1/on-chain minimumOutput or contracts; build a new oracle/price
source (reuse #18/#248); change the 500bps/deviation thresholds beyond gating
demotion behind the reference; make the cue alarmist.

Files (verify on main, after #272): quote-quorum.ts (applyLowQuorumSanity + ref
wiring) + quote-quorum.test.ts; read #18 + #248 for the reference plumbing.
FEEDBACK: how the reference is sourced per pair, the residual on no-reference pairs,
and "ready for Auditor re-confirm to close NEW2-M-01".
```
