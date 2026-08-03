# CHORE-QUORUM-LOWCONFIDENCE-FIX — honest characterization + render lowConfidence + adversarial tests (→ Auditor)

> **Source:** A-Z review v2 (PR #268) **NEW-2 (confirmed 2/2).** The #260 low-quorum demotion (`quote-quorum.ts`)
> actually **changes which source is presented as best — and therefore which the user is steered to sign/execute** — so
> its module header's "display selection only" characterization is **wrong**; and the `lowConfidence` flag it sets is
> **rendered nowhere** (the thin-quorum safety signal is dead). Execution gates (SC-04, R1, on-chain `minimumOutput`)
> remain intact → **no fund RISK**, but the change is execution-selection-adjacent → it warrants an **Auditor pass**
> (which my original `CHORE-QUOTE-QUORUM-HARDENING` spec under-scoped). This prompt: (1) correct the characterization,
> (2) render `lowConfidence` (non-alarmist), (3) add adversarial 2-source tests. **Then → Auditor.** No execution-gate
> / threshold / contract change. SSH-signed (noreply committer).

## Context
- #260 `quote-quorum.ts`: when **<3 sources respond**, a **>500bps outlier winner is demoted** and the runner-up
  becomes "best" (+ a `lowConfidence` flag; a lone responder is flagged, not dropped). The header says "display
  selection only" — but demoting the winner changes which quote is presented as best, i.e. the one the user then signs
  and executes. Inaccurate characterization.
- The `lowConfidence` flag is set on the result but **rendered nowhere** → the user never sees the thin-quorum signal.

## Objective
Make the #260 behaviour honestly characterized and its safety signal visible, and add adversarial coverage of the
demotion→execution-selection path — **without** changing the execution gates or the demotion thresholds. Then hand to
the Auditor for the fund-flow-adjacent sign-off.

## Requirements
1. **Correct the characterization** in the `quote-quorum.ts` header (and any comment/legacy that says "display-only"):
   state accurately that low-quorum demotion **changes which source is presented as best and therefore which the user
   is steered to execute**, and that it does **not** bypass the execution gates (SC-04 `isKnownSwapSelector`, R1
   `validateCallDataRecipient`, on-chain `minimumOutput`), which remain the terminal backstop.
2. **Render the `lowConfidence` flag** in the quote UI (SwapBox / QuoteBreakdown) as an **informational, non-alarmist**
   cue — e.g. a subtle **bold** label like *"Low confidence — only N source(s) responded"*, **not** a red/scary
   warning (match the house style of the oracle-less note: bold, not coloured-alarm). If the team would rather not
   surface it, the alternative is to remove the dead flag — but **rendering is preferred** (real thin-quorum signal).
   Decide + justify in FEEDBACK.
3. **Adversarial tests (the substance):** add 2-responder-window tests proving the demotion **cannot be gamed to the
   user's harm** — specifically that a manipulated/mis-scaled quote cannot (a) demote a genuinely-good winner so an
   attacker-controlled worse quote becomes "best", nor (b) get promoted-and-presented-as-best itself; and that the
   demotion / `lowConfidence` result is **deterministic**. Reconcile with the #248 deviation guard so they don't
   conflict.
4. **Do NOT change the execution gates or the demotion thresholds** — characterization + UX + tests only. If the
   adversarial tests reveal a real gap in the demotion LOGIC, **flag it for the Auditor**, don't silently patch it.

## Do NOT
- No execution-gate / SC-04 / R1 / on-chain / contract change. Don't alter the 500bps threshold or the demotion
  algorithm (only characterize + render + test). Don't make the `lowConfidence` cue alarmist/coloured. Don't remove the
  flag without justifying in FEEDBACK.

## Files affected (verify on main)
- `quote-quorum.ts` (header/characterization); the SwapBox / QuoteBreakdown quote UI (render `lowConfidence`); the
  quorum tests (adversarial 2-source cases). Read-only: the #248 deviation guard, for reconciliation.

## Expected output
- Branch `chore/quorum-lowconfidence-fix` off latest `origin/main`; SSH-signed; CI green. The header tells the truth;
  `lowConfidence` is rendered (non-alarmist) or removed-with-justification; adversarial 2-source tests prove the
  demotion can't be gamed. FEEDBACK: the render-vs-remove decision + the adversarial results + an explicit note that
  this change is **execution-selection-adjacent and needs an Auditor pass**.

## Quality criteria
The #260 characterization is accurate (no false "display-only"); the thin-quorum signal reaches the user (or is removed
with reason, non-alarmist if shown); the demotion is proven non-gameable in 2-source windows; execution gates and
thresholds untouched; the Auditor hand-off is flagged.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-QUORUM-LOWCONFIDENCE-FIX per docs/Prompts/CHORE-QUORUM-LOWCONFIDENCE-FIX.md.
Branch chore/quorum-lowconfidence-fix off origin/main, SSH-signed (noreply
committer), CI green. Characterization + UX + tests ONLY — no execution-gate,
threshold, or contract change. This is execution-selection-adjacent → flag for an
Auditor pass after.

Context (A-Z review v2, PR #268, NEW-2 confirmed): #260 quote-quorum.ts demotes a
>500bps outlier winner when <3 sources respond, so the runner-up becomes "best" (+
a lowConfidence flag; lone responder flagged not dropped). Two problems: (1) the
module header says "display selection only" but demoting the winner CHANGES which
source the user is steered to sign/execute — inaccurate. (2) the lowConfidence flag
is set but rendered NOWHERE. Execution gates (SC-04, R1, on-chain minimumOutput)
stay intact -> no fund risk, but it's execution-selection-adjacent.

Do:
1. Correct the quote-quorum.ts header (+ any "display-only" legacy): state that
   low-quorum demotion changes which source is presented as best and therefore
   which the user executes, and that it does NOT bypass the execution gates (SC-04/
   R1/on-chain minimumOutput = terminal backstop).
2. Render the lowConfidence flag in SwapBox/QuoteBreakdown as an INFORMATIONAL,
   NON-alarmist cue (subtle bold label like "Low confidence — only N source(s)
   responded"; NOT red/scary — match the oracle-less note house style). Prefer
   rendering; removal only with justification in FEEDBACK.
3. Adversarial 2-responder tests: prove the demotion cannot be gamed to the user's
   harm — a manipulated/mis-scaled quote can't (a) demote a good winner so an
   attacker's worse quote becomes best, nor (b) be promoted-as-best itself; and the
   demotion/lowConfidence result is deterministic. Reconcile with the #248 deviation
   guard.
4. Do NOT change the execution gates or the 500bps threshold / demotion algorithm.
   If the adversarial tests reveal a logic gap, FLAG it for the Auditor — don't
   silently patch.

Do NOT: execution-gate/SC-04/R1/on-chain/contract change; alter the threshold or
algorithm; alarmist/coloured lowConfidence cue; remove the flag without justifying.

Files (verify on main): quote-quorum.ts (header); SwapBox/QuoteBreakdown (render);
quorum tests (adversarial 2-source); read #248 for reconciliation. FEEDBACK:
render-vs-remove decision + adversarial results + explicit "needs Auditor pass"
note.
```
