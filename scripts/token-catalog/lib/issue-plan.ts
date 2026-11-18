/**
 * [fix/catalog-refresh-drops-untrusted] Which GitHub issue action does a chain's refresh need?
 * Pure — the CLI (../refresh-issue.ts) lists the open issues and runs the plan.
 *
 * One open "[token-catalog-guard] chain N refresh failed" issue per chain, never two:
 *  - a failed run comments on the chain's open issue, and creates one only when there is none;
 *  - a passing run closes every open issue for that chain (with a link to the run).
 *
 * Matching is by EXACT title on the open-issue LIST (not the search index, which lags and ranks
 * fuzzily: it is how a second issue for one chain could be created next to an indexing delay).
 */
export interface IssueRef {
  number: number
  title: string
}

export function failureIssueTitle(chainId: number | string): string {
  return `[token-catalog-guard] chain ${chainId} refresh failed`
}

export type IssueAction = { action: 'create' } | { action: 'comment'; number: number }

/** A failed refresh: comment on the lowest-numbered open issue for the chain, else create one. */
export function planFailureIssue(chainId: number | string, open: readonly IssueRef[]): IssueAction {
  const title = failureIssueTitle(chainId)
  const mine = open.filter((i) => i.title === title).sort((a, b) => a.number - b.number)
  return mine.length > 0 ? { action: 'comment', number: mine[0].number } : { action: 'create' }
}

/** A passing refresh: every open issue for that chain (a duplicate from an older bug included). */
export function planPassClose(chainId: number | string, open: readonly IssueRef[]): number[] {
  const title = failureIssueTitle(chainId)
  return open.filter((i) => i.title === title).map((i) => i.number).sort((a, b) => a - b)
}
