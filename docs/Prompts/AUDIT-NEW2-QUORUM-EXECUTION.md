# AUDIT-NEW2-QUORUM-EXECUTION — Auditor sign-off of the low-quorum demotion (a real gap was flagged)

> **For:** Auditor (READ-ONLY — reviews, never edits; classifies C/H/M/L; produces remediation prompts for the Code
> Agent, never patches). **Trigger:** the NEW-2 work is on **PR #272 (`chore/quorum-lowconfidence-fix`) — UNMERGED; it
> stays unmerged until this sign-off.** **Why:** the A-Z review v2 found the #260 low-quorum demotion **changes which
> source the user executes** (execution-selection-adjacent, under-scoped as "display-only"). During implementation the
> Code Agent's **own adversarial tests flagged a real gap (not patched)** — this audit confirms, classifies, and bounds it.

## The flagged gap (Code Agent, pinned `(a) FLAGGED GAP (Auditor)` in `quote-quorum.test.ts`)
The 500bps demotion is **gameable ONE-WAY**: in a <3-responder window the band always demotes the *winner* when the
top-two spread is >500bps, but a 2-point spread carries no information about **which** side is lying — so a source
quoting **>500bps UNDER an honest winner** gets the honest quote **demoted** and the liar **presented as best**. Not
patched; 3 remediation options in FEEDBACK: `flag-without-reorder` / `external-reference-confirmed demotion` /
`accept-as-is`.

## Baseline (plan §0)
Audit the **PR #272 head** (`chore/quorum-lowconfidence-fix`); fetch + **record the audited SHA**. Ground on #260
(`quote-quorum.ts` 500bps demotion + `lowConfidence`), #248 (deviation guard), #18 (oracle-less advisory / Chainlink
consent gate), #261 (`executable-sources`), and the gates (SC-04 `isKnownSwapSelector`, R1 `validateCallDataRecipient`,
on-chain `minimumOutput`).

## Objective
Confirm + classify the flagged gap, **verify the stated bounds actually hold (no fund-loss path)**, hunt any other gap,
and recommend a remediation option — so NEW-2 can merge with the right fix.

## Must-verify (negative-path first)
1. **Confirm + classify the one-way gap** (C/H/M/L) with evidence; hunt any **other** gaming direction / rounding /
   ordering edge the Code Agent's tests didn't cover.
2. **Bounds hold — no fund-loss path.** Even under the gap: `lowConfidence` fires **and renders** (non-alarmist, no
   XSS); the Chainlink consent gate catches **≥2% deviation** (hard block **>25%**); the DefiLlama guard is
   **non-overridable**; on-chain **`minimumOutput`** bounds the fill; the **tiered USD limits** apply. Confirm the
   **residual exposure = ONLY pairs that are oracle-less AND DefiLlama-less, under the USD limits** — nothing worse.
3. **Execution gates terminal.** Whatever the demotion picks, SC-04 + R1 + on-chain `minimumOutput` still bind (no
   misroute, no settle below floor) → worst case = **display/price, never fund loss**.
4. **Characterization accurate** (header no longer "display-only"; names the gates). **Composes with #248/#18/#261** —
   no double-demotion / gap / contradiction; a quote-only source can't be promoted as the executable winner. Tests
   **deterministic** (reconcile the NEW-1 flake).
5. **Assess the 3 options + recommend one.** *Architect leans **option 2** — external-reference-confirmed demotion
   (only demote when Chainlink/DefiLlama confirms the winner is the outlier) + `flag-without-reorder` fallback for
   oracle-less+DefiLlama-less pairs; ties to #18.*

## Verdict rule
A flagged **M/L does NOT block merge** if the bounds hold (no fund-loss path) **and** a remediation prompt is produced.
Only a Critical/High unbounded fund path blocks.

## Deliverable
A report: audited SHA, checks table, the gap's severity + evidence, the bounds-verification (the full chain of gates →
fund-loss? no), any new finding, the options assessment + recommendation, the verdict, and the remediation-prompt
handoff to the Code Agent. SSH-signed commit or left for the owner.

---

### `/goal` paste for the Auditor (≤4000)
```
AUDIT-NEW2-QUORUM-EXECUTION per docs/Prompts/AUDIT-NEW2-QUORUM-EXECUTION.md.
READ-ONLY — review only, never edit; classify C/H/M/L; produce Code-Agent
remediation prompts (do NOT patch).

Baseline: audit the PR #272 head (branch chore/quorum-lowconfidence-fix — UNMERGED;
it stays unmerged until you sign off). Fetch + RECORD the audited SHA. Ground on
#260 (quote-quorum.ts 500bps demotion + lowConfidence), #248 (deviation guard), #18
(oracle-less advisory / Chainlink consent gate), #261 (executable-sources), gates
(SC-04, R1 validateCallDataRecipient, on-chain minimumOutput).

CONTEXT: the Code Agent's own adversarial tests already FLAGGED a real gap (not
patched, pinned as "(a) FLAGGED GAP (Auditor)" in quote-quorum.test.ts): the 500bps
demotion is gameable ONE-WAY — a source quoting >500bps UNDER an honest winner
forces the honest winner demoted and the liar presented as best (the band can't
tell which side lies). FEEDBACK gives 3 options: flag-without-reorder /
external-reference-confirmed demotion / accept-as-is.

Do:
1. INDEPENDENTLY CONFIRM the flagged one-way gap + CLASSIFY severity (C/H/M/L) with
   evidence. Hunt any OTHER gaming direction / rounding / ordering edge not covered.
2. VERIFY the claimed BOUNDS hold — even under the gap NO fund-loss path:
   lowConfidence fires AND renders (non-alarmist, no XSS); Chainlink consent gate
   catches >=2% deviation (hard block >25%); DefiLlama guard non-overridable;
   on-chain minimumOutput bounds the fill; tiered USD limits apply. Confirm residual
   exposure = ONLY pairs oracle-less AND DefiLlama-less, under the USD limits.
3. EXECUTION GATES terminal: whatever the demotion picks, SC-04 + R1 + on-chain
   minimumOutput still bind -> worst case = display/price, never fund loss.
4. Characterization accurate (header no longer "display-only"; names the gates).
   Composes with #248/#18/#261 (no double-demotion/gap/contradiction; a quote-only
   source can't be promoted as executable winner). Tests deterministic (NEW-1 flake).
5. ASSESS the 3 options + RECOMMEND one. Architect leans OPTION 2 =
   external-reference-confirmed demotion (only demote when Chainlink/DefiLlama
   confirms the winner is the outlier) + flag-without-reorder fallback for
   oracle-less+DefiLlama-less pairs; ties to #18.

Verdict rule: a flagged M/L does NOT block merge if bounds hold (no fund-loss path)
AND a remediation prompt is produced; only an unbounded C/H fund path blocks.

Deliver a report: audited SHA, checks table, the gap's severity + evidence, the
bounds-verification (full chain of gates -> fund-loss? no), any new finding, the
options assessment + recommendation, verdict, remediation-prompt handoff.
SSH-signed or left for owner.
```
