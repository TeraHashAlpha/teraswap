# CHORE-P0-RESCUE-AUDIT-REPORTS — rescue the 27 local-only audit reports + stop the recurrence

> **Source:** P0 of the A-Z review (v2, PR #268, SHA 4524a97). The main working copy is on the DEAD branch
> `docs/inc-2026-06-09` (**296 commits behind origin/main**), and **~27 cadenced audit reports exist ONLY on that local
> disk, untracked** (Dailies 2026-06-14→07-06, 3 Weeklies, the July Monthly, the Q3 Quarterly); origin's cadence
> stopped 2026-06-13, and the health-report generator keeps writing to the dead-branch working copy. **A single disk
> failure loses ~3 weeks of audit history.** This is the only urgent item. Docs + generator/tooling only — **no
> contract / fund-flow / execution change.** SSH-signed (noreply committer).

## Objective
Get the ~27 reports onto `origin/main` (signed PR), and change the generator so audit reports can never again live only
on a dead-branch working copy. Nothing deleted (rule #4).

## Requirements
1. **Enumerate** the untracked cadenced reports on the working copy (`git status --porcelain` / `git ls-files
   --others --exclude-standard`), scoped to the audit-report paths (e.g. `Audits/Daily/`, `Audits/Weekly/`,
   `Audits/Monthly/`, `Audits/Quarterly/` — verify the real paths). Confirm the set = the Dailies 06-14→07-06 + 3
   Weeklies + July Monthly + Q3 Quarterly (~27). List them in FEEDBACK. Do **not** sweep in unrelated untracked files
   (e.g. `.w0onchain.mjs`, `.remember/`, scratch) — reports only.
2. **Rescue via a signed PR:** branch off **latest `origin/main`**, add exactly those report files at their intended
   taxonomy paths, ONE (or per-cadence) SSH-signed commit, open a PR. Docs-only → CI green. Preserve the existing
   `Audits/` structure.
3. **Secret-scan before commit:** confirm no report embeds a secret (gitleaks runs in CI, but check — these are
   internal audit docs). If any does, **flag it in FEEDBACK and exclude it**, don't commit.
4. **Stop the recurrence — fix the generator:** locate the health-report generator (script/workflow/scheduled task).
   Change it so each run writes to a **tracked** location AND **auto-commits + pushes** to a dedicated tracked branch
   (or appends to a rolling PR) using the noreply signing identity — so a report is never only on a local working
   copy again. If the generator is **owner-run / external** (not in-repo), do NOT guess — document the exact change the
   owner must make (path + auto-commit step) in FEEDBACK.
5. **Owner action (document, do NOT perform):** after this PR merges, the owner moves their local checkout off the dead
   branch — `git checkout main && git pull` — and stops working on `docs/inc-2026-06-09`. State this clearly in
   FEEDBACK.

## Do NOT
- Don't delete anything (rule #4). Don't touch contracts / fund-flow / execution paths. Don't force-push over history.
- Don't move the owner's local branch pointer for them. Don't commit any file that scans as containing a secret.
- Don't bundle unrelated cleanup — this PR is the report rescue + the generator fix only.

## Files affected (verify on main)
- The ~27 untracked report files under `Audits/…`; the health-report generator (script / GitHub Actions workflow /
  scheduled task) — locate it and adjust its output target + auto-commit.

## Expected output
- Branch `chore/rescue-audit-reports` off latest `origin/main`; SSH-signed; CI green. The ~27 reports are committed at
  their taxonomy paths; the generator now writes to a tracked path + auto-commits/pushes (or the owner change is
  documented if it's external). FEEDBACK: the exact rescued file list, the generator change, any excluded
  secret-bearing file, and the owner's local-checkout step.

## Quality criteria
The ~27 reports are on `origin/main` (no longer only on a local disk); the generator can't recur the data-loss (tracked
+ auto-commit, or the owner step is documented); nothing deleted; no secret committed; no contract/fund-flow change; the
owner's branch-move step is written down.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-P0-RESCUE-AUDIT-REPORTS per docs/Prompts/CHORE-P0-RESCUE-AUDIT-REPORTS.md.
Branch chore/rescue-audit-reports off latest origin/main, SSH-signed (noreply
committer), CI green. Docs + generator/tooling ONLY — no contract/fund-flow/
execution change. URGENT (P0 data-loss).

Context (A-Z review v2, PR #268): the main working copy is on the DEAD branch
docs/inc-2026-06-09 (296 commits behind origin/main) and ~27 cadenced audit reports
exist ONLY on that local disk, untracked (Dailies 2026-06-14->07-06 + 3 Weeklies +
July Monthly + Q3 Quarterly); the generator keeps writing there. Disk failure = ~3
weeks of audit history lost.

Do:
1. Enumerate the untracked cadenced reports (git ls-files --others
   --exclude-standard), scoped to the audit-report paths (Audits/Daily|Weekly|
   Monthly|Quarterly — verify real paths). Confirm ~27 = Dailies 06-14->07-06 + 3
   Weeklies + July Monthly + Q3 Quarterly. Do NOT sweep unrelated untracked files
   (.w0onchain.mjs, .remember/, scratch).
2. Rescue via a signed PR: branch off latest origin/main, add exactly those reports
   at their taxonomy paths, SSH-signed commit(s), open a PR. Docs-only, CI green.
3. Secret-scan before commit: if any report embeds a secret, EXCLUDE it + flag in
   FEEDBACK (don't commit it).
4. Stop the recurrence: locate the health-report generator; make each run write to
   a TRACKED path AND auto-commit+push to a dedicated tracked branch (or a rolling
   PR) with the noreply identity. If the generator is owner-run/external, do NOT
   guess — document the exact owner change in FEEDBACK.
5. Owner action (document, do NOT perform): after merge, owner runs `git checkout
   main && git pull` and stops working on docs/inc-2026-06-09.

Do NOT: delete anything (rule #4); touch contracts/fund-flow/execution; force-push;
move the owner's branch pointer; commit a secret-bearing file; bundle unrelated
cleanup.

Deliver: the signed PR (reports at taxonomy paths + generator fix). FEEDBACK: the
exact rescued file list, the generator change (or the owner change if external), any
excluded secret file, and the owner's local-checkout step.
```
