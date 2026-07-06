# Runbook — Audit cadence reports: generation, persistence, recovery

> **Origin:** CHORE-P0-RESCUE-AUDIT-REPORTS (P0 of `Audits/Reviews/AZ-REVIEW-2026-07-06.md`). 28 cadenced
> reports existed only untracked on one machine because the generators write to a local working copy with no
> commit/push step. This runbook is the durable fix procedure. Nothing here touches contracts or fund flow.

## 1. Where the reports come from

The Daily/Weekly/Monthly/Quarterly reports under `Audits/{Daily,Weekly,Monthly,Quarterly}/` are written by
**owner-level Claude Code scheduled tasks** (outside this repo):

```
~/.claude/scheduled-tasks/teraswap-daily-health/SKILL.md
~/.claude/scheduled-tasks/teraswap-weekly-audit/SKILL.md
~/.claude/scheduled-tasks/teraswap-monthly-security/SKILL.md
~/.claude/scheduled-tasks/teraswap-quarterly-rotation/SKILL.md
```

Each hardcodes the working copy `/Users/tiagocruz/Desktop/Claude/dex-aggregator 2` and ends by writing a
report file there — **without committing**. If that working copy sits on a stale branch (as it did:
`docs/inc-2026-06-09`, 296 behind), reports pile up untracked on one disk.

## 2. The persistence step (OWNER ACTION — one line per SKILL.md)

`scripts/commit-audit-report.mjs` (tracked, this repo) commits any new/modified cadence report to the
dedicated tracked branch **`audits/cadence`** and pushes — via a temp detached worktree, so it never switches
the operator's branch, never stashes, never force-pushes, only ever stages
`Audits/{Daily,Weekly,Monthly,Quarterly}/*.md`, and inherits the repo's noreply + SSH-signing config.

**Add as the FINAL step of each of the four SKILL.md files above:**

```
## Persist (obrigatório, último passo)
Run: `cd "/Users/tiagocruz/Desktop/Claude/dex-aggregator 2" && node scripts/commit-audit-report.mjs`
— it commits the new report to the tracked branch `audits/cadence` and pushes. If it errors, include the
error in the report email.
```

Periodically (e.g., at sprint close) merge `audits/cadence` into `main` via a docs-only PR.

## 3. Known defects in the current SKILL.md files (fix while editing — owner)

1. **Wrong domain:** `teraswap-monthly-security` and `teraswap-quarterly-rotation` curl
   `https://teraswap.io` for CSP checks. The canonical production host is **`https://www.teraswap.app`**;
   `teraswap.io` is not ours — checks against it are meaningless (and its resolution should be treated as a
   typo-domain signal, which the monthly check already covers separately).
2. **`npm audit fix` on the live working copy:** `teraswap-weekly-audit` runs `npm audit fix` (and build,
   with a `git checkout -- package.json package-lock.json` revert path) directly in the operator's checkout.
   On a stale branch this mutates tracked files outside any review flow (it is how `package.json`/lockfile
   showed modified on the dead branch). Recommendation: make the weekly audit **report-only** (no `fix`);
   dependency bumps belong in reviewed PRs (Dependabot + the audit-gate already cover this).
3. **Stale local secret:** the daily check's `/api/monitor` call reads `MONITOR_SECRET` from the working
   copy's `.env`, which is outdated (rotated on Vercel) → permanent 401 ⚠ noise in every Daily since the
   rotation. Update the local `.env` value or drop that check to unauthenticated endpoints.

## 4. Recovery procedure (what was done 2026-07-06, repeat if it ever recurs)

1. Enumerate strictly: `git ls-files --others --exclude-standard | grep -E '^Audits/(Daily|Weekly|Monthly|Quarterly)/'`.
2. Split the list: for each file, `git cat-file -e origin/main:<path>` → absent = rescue set; present =
   compare sha256 vs the committed blob (drift check — 2026-07-06: 9 overlaps, all byte-identical).
3. Secret-scan the rescue set (`gitleaks dir <cadence dirs> --config .gitleaks.toml` + a pattern battery)
   **before** committing; exclude and flag anything that hits.
4. Copy the rescue set into a fresh worktree off latest `origin/main`, commit (SSH-signed), PR, CI green.

## 5. Owner checkout step (after the rescue PR merges)

The main working copy must leave the dead branch:

```
cd "/Users/tiagocruz/Desktop/Claude/dex-aggregator 2"
git checkout main && git pull
```

Do **not** delete `docs/inc-2026-06-09` (rule #4) — just stop working on it. The remaining untracked
non-cadence files there (e.g. `.w0onchain.mjs`, prompt drafts) are out of scope of this runbook.
