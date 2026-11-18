#!/usr/bin/env tsx
/**
 * [fix/catalog-refresh-drops-untrusted] CLI for the refresh workflow's issue handling.
 *
 *   refresh-issue.ts alert <chainId> <bodyFile>   comment on the chain's open failure issue, or create it
 *   refresh-issue.ts close <chainId> <runUrl>     close the chain's open failure issue(s), linking the run
 *
 * Needs GH_TOKEN (the workflow's GITHUB_TOKEN, issues: write) and GITHUB_REPOSITORY. The open
 * issues come from `gh issue list` (the list endpoint, exact-title match) — if that call fails
 * the script exits non-zero WITHOUT creating anything: a failed lookup must never become a second
 * issue for a chain that already has one.
 */
import { execFileSync } from 'node:child_process'
import { failureIssueTitle, planFailureIssue, planPassClose, type IssueRef } from './lib/issue-plan'

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function openIssues(repo: string): IssueRef[] {
  const raw = gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,title'])
  return JSON.parse(raw) as IssueRef[]
}

function main(): void {
  const [mode, chain, arg] = process.argv.slice(2)
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo || !chain || !arg || (mode !== 'alert' && mode !== 'close')) {
    console.error('usage: refresh-issue.ts <alert|close> <chainId> <bodyFile|runUrl>  (GITHUB_REPOSITORY must be set)')
    process.exit(2)
  }
  const open = openIssues(repo)
  if (mode === 'alert') {
    const plan = planFailureIssue(chain, open)
    if (plan.action === 'comment') {
      gh(['issue', 'comment', String(plan.number), '--repo', repo, '--body-file', arg])
      console.log(`chain ${chain}: commented on open issue #${plan.number}`)
    } else {
      gh(['issue', 'create', '--repo', repo, '--title', failureIssueTitle(chain), '--body-file', arg])
      console.log(`chain ${chain}: opened a failure issue`)
    }
    return
  }
  const numbers = planPassClose(chain, open)
  if (numbers.length === 0) {
    console.log(`chain ${chain}: no open failure issue to close`)
    return
  }
  for (const n of numbers) {
    gh(['issue', 'close', String(n), '--repo', repo, '--comment', `The refresh for chain ${chain} passed — ${arg}`])
    console.log(`chain ${chain}: closed #${n}`)
  }
}

main()
