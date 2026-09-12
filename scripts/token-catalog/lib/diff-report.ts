/**
 * [fix/token-sync-cron-landing] Pure diff between two versions of one chain's catalog rows —
 * feeds the cron's per-chain PR body ("added/removed/changed" counts) so a reviewer sees
 * what a run actually did without reading the raw JSON diff.
 */
import type { CatalogRow } from './types'

export interface CatalogDiff {
  added: CatalogRow[]
  removed: CatalogRow[]
  /** Same address in both, but at least one field differs (verified/decimals/symbol/etc). */
  changed: Array<{ address: string; before: CatalogRow; after: CatalogRow }>
}

function byAddr(rows: CatalogRow[]): Map<string, CatalogRow> {
  return new Map(rows.map((r) => [r.address.toLowerCase(), r]))
}

export function diffCatalogs(before: CatalogRow[], after: CatalogRow[]): CatalogDiff {
  const beforeByAddr = byAddr(before)
  const afterByAddr = byAddr(after)
  const added: CatalogRow[] = []
  const removed: CatalogRow[] = []
  const changed: CatalogDiff['changed'] = []

  for (const [addr, row] of afterByAddr) {
    const prior = beforeByAddr.get(addr)
    if (!prior) {
      added.push(row)
    } else if (JSON.stringify(prior) !== JSON.stringify(row)) {
      changed.push({ address: addr, before: prior, after: row })
    }
  }
  for (const [addr, row] of beforeByAddr) {
    if (!afterByAddr.has(addr)) removed.push(row)
  }
  return { added, removed, changed }
}

export function formatDiffSummary(chainId: number, diff: CatalogDiff): string {
  const lines = [
    `chain ${chainId}: +${diff.added.length} added, -${diff.removed.length} removed, ~${diff.changed.length} changed`,
  ]
  for (const t of diff.added.slice(0, 20)) lines.push(`  + ${t.symbol} ${t.address}`)
  for (const t of diff.removed.slice(0, 20)) lines.push(`  - ${t.symbol} ${t.address}`)
  for (const c of diff.changed.slice(0, 20)) lines.push(`  ~ ${c.after.symbol} ${c.address}`)
  return lines.join('\n')
}
