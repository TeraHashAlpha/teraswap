import { CATEGORY_DISPLAY_ORDER, type Token, type TokenCategory } from '@/lib/tokens'
import { isCuratedToken } from '@/lib/chains/tokens'
import type { PortfolioToken } from '@/hooks/usePortfolio'
import type { ApprovalRecord } from '@/hooks/useActiveApprovals'

/**
 * [ADR-025 / B8 Portfolio] Pure display model. Everything here restates a rule v1's `PortfolioTab` / `ActiveApprovals` apply inline (their
 * helpers are module-private), so the v2 tab groups, labels and times exactly as v1 does — `portfolio.test.tsx` renders both on one fixture
 * and compares. NO price or balance is computed here: USD and balances come from `usePortfolio()` untouched.
 */

/** v1 treats any held token OUTSIDE the ACTIVE chain's curated list as "Discovered in Wallet" (Add) — shared `isCuratedToken`, per chain. */
export function isDefaultToken(token: Token, chainId: number): boolean {
  return isCuratedToken(token.address, chainId)
}

function categoryIndex(cat: TokenCategory): number {
  const idx = CATEGORY_DISPLAY_ORDER.indexOf(cat)
  return idx === -1 ? CATEGORY_DISPLAY_ORDER.length : idx
}

export interface PortfolioGroups {
  /** Curated tokens, bucketed by category in CATEGORY_DISPLAY_ORDER (rows keep the hook's USD-desc order). */
  grouped: Array<[TokenCategory, PortfolioToken[]]>
  /** Held tokens outside the curated set, in the hook's order. */
  discovered: PortfolioToken[]
}

/** v1's split (PortfolioTab useMemo): curated → category buckets, the rest → Discovered in Wallet. */
export function groupPortfolio(tokens: readonly PortfolioToken[], chainId: number): PortfolioGroups {
  const buckets = new Map<TokenCategory, PortfolioToken[]>()
  const discovered: PortfolioToken[] = []
  for (const entry of tokens) {
    if (isDefaultToken(entry.token, chainId)) {
      const list = buckets.get(entry.token.category) ?? []
      list.push(entry)
      buckets.set(entry.token.category, list)
    } else {
      discovered.push(entry)
    }
  }
  return { grouped: Array.from(buckets.entries()).sort(([a], [b]) => categoryIndex(a) - categoryIndex(b)), discovered }
}

/** v1's `shortenAddress` (the "…" is the single ellipsis character). */
export function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** v1's "Last updated …" clock: just now / Ns / Nm / Nh ago. */
export function formatLastUpdated(date: Date | null, now: number): string {
  if (!date) return ''
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

/** v1's `ActiveApprovals.timeSince`: just now / Nm / Nh / Nd ago. */
export function timeSince(ts: number, now: number = Date.now()): string {
  const seconds = Math.floor((now - ts) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/** v1's allowance label for an approval record. */
export function methodLabel(method: ApprovalRecord['method']): string {
  return method === 'infinite' ? 'Infinite allowance' : method === 'exact' ? 'Exact allowance' : 'Permit2'
}

/** v1's `revoke.cash` link for approvals outside TeraSwap — a wallet-keyed URL, not chain-keyed (v1). */
export function revokeCashUrl(address: string): string {
  return `https://revoke.cash/address/${address}`
}

/**
 * The approvals panel's rows: v1's actionable set (`active && needsRevoke`, store order) PLUS any row revoked in this view, which stays
 * listed so its "✓ Revoked ↗" can be read (v1 drops it the instant the tx confirms).
 */
export function approvalRows(approvals: readonly ApprovalRecord[], revokedIds: ReadonlySet<string>): ApprovalRecord[] {
  return approvals.filter((a) => (a.active && a.needsRevoke) || revokedIds.has(a.id))
}
