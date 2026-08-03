#!/usr/bin/env node
/**
 * [CHORE-P0-RESCUE-AUDIT-REPORTS] Auto-commit + push cadence audit reports.
 *
 * Why this exists: the health-report generators (owner-level Claude scheduled
 * tasks in ~/.claude/scheduled-tasks/teraswap-*) write Daily/Weekly/Monthly/
 * Quarterly reports into the local working copy with NO commit/push step. The
 * working copy sat on a dead branch for weeks, so 28 reports existed only on
 * one disk (P0 of AZ-REVIEW-2026-07-06, rescued in this PR). This script makes
 * a report durable the moment it is written: each run commits any new/modified
 * cadence report to the dedicated tracked branch `audits/cadence` and pushes —
 * WITHOUT touching the operator's checked-out branch (temp detached worktree).
 *
 * [CHORE-DAILY-HEALTH-REPORT-GHA] The DAILY health report specifically no longer depends on this
 * script: `.github/workflows/daily-health-report.yml` now generates AND persists it end to end on
 * a schedule, on GitHub's infrastructure, so it needs no local SSH signing key (the recurring
 * failure this whole script exists to route around — see any Audits/Daily/health-*.md before that
 * workflow shipped for the "fatal: either user.signingkey..." error every sandboxed run hit) and
 * checks PRODUCTION directly rather than a sandbox's unset local env vars. This script remains the
 * PRIMARY persistence path for Weekly/Monthly/Quarterly reports (not yet moved to a scheduled
 * Action) and stays available for a manually-run or ad hoc Daily report.
 *
 * Usage (appended to each generator SKILL.md as its final step):
 *   node scripts/commit-audit-report.mjs
 *
 * Guarantees / safety:
 *   - Scopes to Audits/{Daily,Weekly,Monthly,Quarterly}/*.md ONLY — never
 *     sweeps unrelated untracked files.
 *   - Never switches the operator's branch, never stashes, never force-pushes.
 *   - Commits inherit the repo-local identity + SSH signing config (noreply
 *     committer, commit.gpgsign=true — rule #12).
 *   - Branch base: existing origin/audits/cadence tip, else origin/main.
 *   - Exit 0 with a message when there is nothing new (idempotent).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// AUDIT_REPO_DIR lets a scheduled task target a specific checkout explicitly;
// default is the repo containing this script.
const REPO = process.env.AUDIT_REPO_DIR
  ? resolve(process.env.AUDIT_REPO_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CADENCE_DIRS = ['Audits/Daily', 'Audits/Weekly', 'Audits/Monthly', 'Audits/Quarterly']
const BRANCH = 'audits/cadence'

const git = (args, cwd = REPO) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// 1. Enumerate new/modified cadence reports in the operator's working copy.
//    --porcelain: "?? path" (untracked) / " M path" (modified). Reports only.
const status = git(['status', '--porcelain', '--', ...CADENCE_DIRS])
const files = status
  .split('\n')
  .filter(Boolean)
  .map((l) => l.slice(3).trim())
  .filter((f) => f.endsWith('.md'))

if (files.length === 0) {
  console.log('[commit-audit-report] nothing new under Audits cadence dirs — done.')
  process.exit(0)
}
console.log(`[commit-audit-report] ${files.length} report(s) to persist:\n  ${files.join('\n  ')}`)

// 2. Base the dedicated branch on its remote tip (or origin/main on first run).
git(['fetch', 'origin', 'main'])
let base = `origin/${BRANCH}`
try {
  git(['fetch', 'origin', BRANCH])
  git(['rev-parse', '--verify', base])
} catch {
  base = 'origin/main'
}

// 3. Temp detached worktree → copy reports in → signed commit → push.
const tmp = mkdtempSync(join(tmpdir(), 'audit-cadence-'))
try {
  git(['worktree', 'add', '--detach', tmp, base])
  for (const f of files) {
    mkdirSync(join(tmp, dirname(f)), { recursive: true })
    cpSync(join(REPO, f), join(tmp, f), { preserveTimestamps: true })
  }
  git(['add', '--', ...CADENCE_DIRS], tmp)
  // Anything staged? (report may already be on the branch from a prior run)
  const staged = git(['diff', '--cached', '--name-only'], tmp).split('\n').filter(Boolean)
  if (staged.length === 0) {
    console.log('[commit-audit-report] all reports already on the branch — done.')
    process.exit(0)
  }
  const names = staged.map((f) => f.split('/').pop())
  const summary =
    names.length <= 6 ? names.join(', ') : `${names.slice(0, 6).join(', ')} +${names.length - 6} more`
  git(['commit', '-m', `docs(audits): cadence report(s) ${summary} [auto]`], tmp)
  git(['push', 'origin', `HEAD:refs/heads/${BRANCH}`], tmp)
  console.log(`[commit-audit-report] pushed ${staged.length} file(s) to origin/${BRANCH}.`)
} finally {
  try {
    git(['worktree', 'remove', '--force', tmp])
  } catch {
    rmSync(tmp, { recursive: true, force: true })
  }
}
