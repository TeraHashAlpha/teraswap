# CHORE-QUOTE-QUORUM-HARDENING — trustworthy displayed winner in low quorum + source-health alerting

> **Source:** T-SAF W7-L-02 coverage-check report (2026-07-02). Two structural gaps behind the OpenOcean/Balancer/
> silent-source problems: (a) the displayed-winner **outlier filter can't discriminate with only 2 responders**, so a
> mis-scaled/manipulated quote wins the *display*; (b) **no monitoring** alerts when a source dies, emits garbage, or
> goes silent — all three defects went unnoticed until an adversarial audit. **Display + observability only. No change
> to the execution gates (SC-04, on-chain `minimumOutput`), no contract change, no deploy.** SSH-signed (noreply
> committer). Two independent commits.

## Context
- The quote-selection **outlier filter** (drop a quote > 3× the median, guarded by a `1.5×max` threshold) is
  **mathematically inert when only 2 sources respond** — with two values the median/max relationship can't flag
  either as an outlier. Result: a 10^n-mis-scaled quote (OpenOcean) or a manipulated/erroneous quote can **win the
  displayed "best price."** Execution is still safe (SC-04 → 9O fallback + on-chain `minimumOutput`), but the user is
  shown a false number → erodes trust and can waste a signing attempt.
- **No source-health monitoring:** Balancer 404ing (0 quotes ever), OpenOcean emitting 10^n garbage, and Odos going
  from 614 quotes/17% wins to **silent** were all invisible until the audit. A meta-aggregator's value **is** source
  breadth; silent/broken sources must page.

## Objective
Make the displayed winner defensible in **every** quorum (including 2 responders), and alert on source-health
regressions. Do not touch the execution/settlement path or any on-chain/SC-04 gate.

## Requirements (two independent commits)

### Commit 1 — low-quorum display sanity
- When **fewer than 3 sources respond** (median-outlier filter can't discriminate), apply a **stricter cross-check**
  before showing a winner:
  - require the winning quote to be within a **bounded deviation** of the runner-up (explicit, configurable bps/%),
    and/or cross-check the winner against the existing **cross-agg deviation guard (#248)** and/or the **oracle-less
    advisory (#18)** reference where available;
  - if the top quote **fails the sanity band**, do **not** display it as best — drop it (fall to the next sane quote)
    or surface it as **low-confidence**, never as the headline best price.
- Make the threshold **explicit and tested.** Add a **2-source-with-garbage fixture** that reproduces the OpenOcean
  10^n case → assert the garbage quote **cannot win the display**. Also a 1-source and a 2-sane-sources case (no false
  drops).

### Commit 2 — source-health monitoring/alerting
- Extend the existing monitor (`src/app/api/monitor/route.ts`, which already tracks per-source `wins`/`trades`/
  `failed`) to **alert** (reuse the #201 / `emitTransitionAlert` path used by W7-L-01) when, over a window:
  - a source that **historically quotes** drops to **0** (death/silence — Balancer, Odos classes);
  - a source's quotes are **systematic outliers** (a mis-scale/units detector — the OpenOcean class);
  - a source's **quote-count or win-rate deviates materially from its baseline**.
- Document the per-source **baselines** and thresholds; make the alert **rate-limited** (one alert per window, like the
  CoW fee-zero alert) so it doesn't spam.
- **Reconcile with #248/#18** so this doesn't double-alert or conflict with the existing deviation/oracle-less paths.

## Do NOT
- Do **not** touch the on-chain gates, the SC-04 `isKnownSwapSelector` allowlist, or the execution/settlement path.
- Do **not** change adapters' fail-soft behavior. This is **display selection + observability** only. No contract
  change, no deploy.

## Files affected (verify on main)
- The quote-aggregation/winner-selection code that holds the 3×-median / 1.5×max outlier filter (locate on main).
- `src/app/api/monitor/route.ts` + the alert path (`alert.js` / `emitTransitionAlert`). New tests/fixtures.

## Expected output
- Branch `chore/quote-quorum-hardening` off latest `origin/main`; SSH-signed; CI green. Two commits (low-quorum
  sanity; source-health alerts). Tests: the 2-source garbage fixture cannot win the display; source death/outlier/
  drift fires one alert at threshold; no false drop for 2 sane sources. FEEDBACK: thresholds chosen + how it
  reconciles with #248/#18.

## Quality criteria
No mis-scaled/outlier quote can win the **displayed** best price in **any** quorum (incl. 2 responders); source death,
garbage, or silence **pages** (rate-limited); zero execution-gate / SC-04 / on-chain / contract change; reconciled with
the existing #248/#18 sanity paths.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-QUOTE-QUORUM-HARDENING per docs/Prompts/CHORE-QUOTE-QUORUM-HARDENING.md.
Branch off origin/main, SSH-signed (noreply committer), CI green, TWO independent
commits. Display-selection + observability ONLY — no change to execution gates
(SC-04, on-chain minimumOutput), no contract change, no deploy, no adapter
fail-soft change.

Context (T-SAF W7-L-02 coverage check, 2026-07-02): (a) the displayed-winner
outlier filter (drop >3x median, guarded by 1.5x-max) is mathematically inert with
only 2 responders, so a 10^n-mis-scaled (OpenOcean) or manipulated quote WINS the
displayed best price (execution still safe via SC-04->9O + on-chain minimumOutput,
but the user sees a false number). (b) No monitoring caught Balancer dying,
OpenOcean emitting garbage, or Odos going silent until the audit.

Commit 1 — low-quorum display sanity: when <3 sources respond, apply a stricter
cross-check before showing a winner — require the winner within a bounded,
configurable deviation of the runner-up, and/or cross-check against the cross-agg
deviation guard (#248) / oracle-less advisory (#18) reference where available; if
the top quote fails the sanity band, do NOT display it as best (fall to next sane
quote or mark low-confidence). Explicit tested threshold. Add a 2-source-with-
garbage fixture (OpenOcean 10^n case) asserting the garbage quote CANNOT win the
display; plus 1-source and 2-sane-sources cases (no false drops).

Commit 2 — source-health alerting: extend src/app/api/monitor/route.ts (already
tracks per-source wins/trades/failed) to alert via the #201/emitTransitionAlert
path when, over a window: a historically-quoting source drops to 0 (death/silence);
a source's quotes are systematic outliers (mis-scale/units detector); or quote-
count/win-rate deviates materially from baseline. Document per-source baselines +
thresholds; rate-limit to one alert per window (like the CoW fee-zero alert).
Reconcile with #248/#18 to avoid double-alerting.

Do NOT: touch on-chain gates, the SC-04 allowlist, or the settlement path; change
adapter fail-soft. Files (verify on main): the winner-selection/outlier-filter
code, src/app/api/monitor/route.ts, the alert path, new tests/fixtures. FEEDBACK:
thresholds + reconciliation with #248/#18.
```
