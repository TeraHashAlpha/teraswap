# AUDIT-NEW2-QUORUM-EXECUTION — Auditor sign-off of the low-quorum demotion (execution-selection-adjacent)

> **For:** Auditor (READ-ONLY — reviews, never edits; classifies findings C/H/M/L; 0C/0H = approved; produces
> remediation prompts for the Code Agent, never patches). **Trigger:** run **after** `chore/quorum-lowconfidence-fix`
> (NEW-2) merges to `origin/main`. **Why:** the A-Z review v2 (NEW-2) found the #260 low-quorum demotion **changes
> which source is presented as best and therefore which the user executes** — so it is **execution-selection-adjacent**,
> which the original `CHORE-QUOTE-QUORUM-HARDENING` under-scoped (shipped as "display-only", no Auditor). This closes
> that gap.

## Baseline (plan §0)
Audit **`origin/main` HEAD** (fetch + assert; read via `git show origin/main:<path>` or a fresh worktree). **Record the
audited SHA.** Ground on: #260 (`quote-quorum.ts`, the 500bps demotion + `lowConfidence`), NEW-2
(`chore/quorum-lowconfidence-fix`), #248 (cross-agg deviation guard), #18 (oracle-less advisory), #261
(`executable-sources` settleable-winner scoping), and the on-chain gates (SC-04 `isKnownSwapSelector`, R1
`validateCallDataRecipient`, on-chain `minimumOutput`).

## Objective
Prove the low-quorum demotion is **safe and non-gameable**, that its user-facing effects are honest, and that even a
worst-case wrong demotion is **bounded by the execution gates to a display/price issue, never fund loss**.

## Must-verify invariants (negative-path FIRST — each must hold)
1. **Demotion is non-gameable (the crux).** In a **<3-responder** window, a manipulated / mis-scaled / attacker-supplied
   quote **cannot**: (a) demote a genuinely-good winner so an attacker-controlled *worse* quote becomes the presented
   "best"; nor (b) get promoted-and-presented-as-best itself. The 500bps band + demotion are **deterministic** and
   applied to the correct pair (winner vs runner-up), with no ordering/rounding edge that flips the outcome.
2. **Execution gates remain the terminal backstop.** Whatever the demotion selects, **SC-04 + R1 + on-chain
   `minimumOutput`** still bind — a demoted/promoted quote can neither misroute funds (recipient≠owner / non-whitelisted
   router fail-closed) nor settle below the on-chain floor. So a wrong demotion is at worst a **display/price** issue.
3. **`lowConfidence` render is honest + safe.** It accurately reflects thin quorum, is **non-alarmist** (house style:
   bold, not coloured-alarm), does **not** over/under-warn, and **cannot XSS** — the source count/name in the label is
   React-escaped (tie W9); no `dangerouslySetInnerHTML`.
4. **Characterization is accurate.** The `quote-quorum.ts` header no longer claims "display-only"; it correctly states
   the execution-selection impact + names the gates as the backstop.
5. **Composes with #248 / #18 without conflict.** The low-quorum sanity band, the cross-agg deviation guard (#248), and
   the oracle-less advisory (#18) compose correctly — no double-demotion, no gap where one disables the other, no
   contradictory user signals.
6. **Composes with #261 executable-sources scoping.** The demotion operates on **settleable** quotes correctly — a
   quote-only source cannot be demoted-into / promoted as the executable winner, and the "first settleable" rebase +
   the low-quorum demotion do not steer the user to a non-settleable or worse quote.
7. **The adversarial tests are sufficient.** The Code Agent's 2-source fixtures actually exercise the (a)/(b) gaming
   vectors + the lone-responder + a quote-only-in-mix case, and are deterministic (no flakiness — reconcile with NEW-1).

## Negative-path battery (each must be refused / bounded)
2-source window with: a 10^n mis-scaled attacker quote · an attacker quote just *inside* the band · an attacker quote
crafted to push a good quote *just over* 500bps so it's demoted · a lone responder · a quote-only source in the mix.
For each: the user is not steered to a harmful/attacker-controlled outcome, and the execution gates bound the worst case.

## Method
Read `quote-quorum.ts` + the SwapBox/QuoteBreakdown render + the quorum tests on the audited SHA; trace the
demotion/threshold logic and the winner→execution path; reconcile against #248/#18/#261; confirm the on-chain gates are
untouched (diff is display-selection + UX + tests only). Re-run the quorum tests; assess whether the adversarial
coverage is complete. On-chain reads via view calls only.

## Exit criteria
Demotion proven non-gameable + deterministic; execution gates confirmed terminal (worst case = display/price, not fund
loss); `lowConfidence` honest/non-alarmist/no-XSS; characterization accurate; composes with #248/#18/#261; adversarial
tests sufficient. **0C/0H = approved.** Any finding → severity (C/H/M/L) + a Code-Agent remediation prompt (Auditor does
not patch).

## Deliverable
A report: audited SHA, checks-run table, findings (Sev · `file:line` · disposition + evidence), negative-path results,
the verdict (0C/0H bar), and the remediation-prompt list. SSH-signed commit, or left for the owner to commit if no
signing key in the sandbox.

---

### `/goal` paste for the Auditor (≤4000)
```
AUDIT-NEW2-QUORUM-EXECUTION per docs/Prompts/AUDIT-NEW2-QUORUM-EXECUTION.md.
READ-ONLY — review only, never edit; classify findings C/H/M/L; 0C/0H = approved;
produce Code-Agent remediation prompts for any finding (do NOT patch). Run AFTER
chore/quorum-lowconfidence-fix (NEW-2) merges.

Baseline: audit origin/main HEAD (fetch+assert; read via `git show origin/main:
<path>` or a fresh worktree); RECORD the audited SHA. Ground on #260 (quote-
quorum.ts 500bps demotion + lowConfidence), NEW-2, #248 (deviation guard), #18
(oracle-less advisory), #261 (executable-sources scoping), and the gates (SC-04,
R1 validateCallDataRecipient, on-chain minimumOutput).

Why: NEW-2 found the #260 low-quorum demotion CHANGES which source is presented as
best and therefore which the user executes — execution-selection-adjacent, which
the original spec under-scoped as "display-only". Prove it's safe.

Prove (negative-path FIRST):
1. Demotion non-gameable (crux): in a <3-responder window a manipulated/mis-scaled/
   attacker quote can NOT (a) demote a genuinely-good winner so an attacker's WORSE
   quote is presented best, nor (b) get promoted-as-best itself. 500bps band +
   demotion deterministic, applied to winner-vs-runner-up, no rounding/ordering
   edge that flips it.
2. Execution gates terminal: whatever the demotion picks, SC-04 + R1 + on-chain
   minimumOutput still bind -> no misroute, no settle below floor -> worst case is
   display/price, never fund loss.
3. lowConfidence render honest + non-alarmist (bold not coloured) + cannot XSS
   (source count/name React-escaped; no dangerouslySetInnerHTML).
4. Characterization accurate: quote-quorum.ts header no longer says "display-only";
   states the execution-selection impact + the gate backstop.
5. Composes with #248/#18: no double-demotion, no gap, no contradictory signals.
6. Composes with #261: demotion works on SETTLEABLE quotes; a quote-only source
   can't be promoted as executable winner; no steer to a non-settleable/worse quote.
7. Adversarial 2-source tests sufficient + deterministic (reconcile NEW-1 flake).

Negative-path battery (each refused/bounded): 2-source window with a 10^n mis-
scaled quote · an attacker quote inside the band · one crafted to push a good quote
just over 500bps · a lone responder · a quote-only source in the mix.

Deliver a report: audited SHA, checks table, findings (Sev·file:line·disposition+
evidence), negative-path results, verdict (0C/0H bar), remediation-prompt list.
SSH-signed commit or left for owner.
```
