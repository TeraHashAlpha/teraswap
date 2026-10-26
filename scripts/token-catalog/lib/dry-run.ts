/**
 * [feat/catalog-single-source-volume] `tokens:sync --dry-run` report for the single-source volume
 * rule: what WOULD be admitted per chain. Pure formatting over the build result — build.ts prints it
 * and skips every write (catalog JSON, trust fixture, output dir). Addresses come from the build
 * result (source payload), the ETHFI line is found by SYMBOL — no address is typed anywhere.
 */
import type { BuildReport, CatalogRow } from './types'
import { medianOf } from './verify'

const BASE_CHAIN_ID = 8453
const SPOTLIGHT_SYMBOL = 'ETHFI'
const TOP_N = 20

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

export function formatSingleSourceDryRun(chainId: number, tokens: CatalogRow[], report: BuildReport): string[] {
  const ss = report.singleSource
  const lines: string[] = [`── single-source volume rule · chain ${chainId} · DRY RUN (nothing written) ──`]
  if (!ss.enabled) return [...lines, 'rule disabled for this chain (cfg.singleSource.enabled = false)']

  const shipped = tokens.filter((t) => t.admission)
  const guardRejected = report.rejections.filter(
    (r) => (r.reason === 'guard-fatal' || r.reason === 'guard-unverifiable') && ss.evaluations.some((e) => e.address === r.address && e.outcome === 'admitted'),
  )
  lines.push(
    `candidates (one CoinGecko vote): ${ss.candidates} · pre-filtered (24h volume unknown/under floor): ${ss.prefiltered} · history calls: ${ss.evaluated}`,
    `rule verdicts: admitted ${ss.admitted} · below floor ${ss.belowFloor} · fetch failed ${ss.fetchFailed} (not admitted)`,
    `would ship: ${shipped.length} · deferred by new-token cap: ${ss.deferred.length} · guard-rejected: ${guardRejected.length}`,
  )

  const top = [...shipped]
    .sort((a, b) => medianOf(b.admission!.dailyVolumeUsd) - medianOf(a.admission!.dailyVolumeUsd) || a.symbol.localeCompare(b.symbol))
    .slice(0, TOP_N)
  lines.push(`top ${Math.min(TOP_N, top.length)} by 7-day median volume:`)
  top.forEach((t, i) => {
    const d = t.admission!.dailyVolumeUsd
    lines.push(`  ${String(i + 1).padStart(2)}. ${t.symbol} ${t.address} · median ${usd(medianOf(d))} · min ${usd(Math.min(...d))} · 24h ${t.volume24hUsd == null ? 'n/a' : usd(t.volume24hUsd)}`)
  })

  if (chainId === BASE_CHAIN_ID) lines.push(spotlightLine(tokens, report))
  return lines
}

function spotlightLine(tokens: CatalogRow[], report: BuildReport): string {
  const want = SPOTLIGHT_SYMBOL.toLowerCase()
  const row = tokens.find((t) => t.symbol.toLowerCase() === want)
  if (row?.admission) {
    const d = row.admission.dailyVolumeUsd
    return `${SPOTLIGHT_SYMBOL}: ADMITTED by the rule (${row.address}) · median ${usd(medianOf(d))} · min ${usd(Math.min(...d))}`
  }
  if (row) return `${SPOTLIGHT_SYMBOL}: already in the catalog without the rule (${row.address}, verified=${row.verified})`
  const ev = report.singleSource.evaluations.find((e) => e.symbol.toLowerCase() === want)
  if (ev) {
    if (report.singleSource.deferred.some((d) => d.address === ev.address)) return `${SPOTLIGHT_SYMBOL}: admitted by the rule but DEFERRED by the new-token cap (${ev.address})`
    const rej = report.rejections.find((r) => r.address === ev.address)
    return `${SPOTLIGHT_SYMBOL}: NOT admitted — rule verdict ${ev.outcome}${rej ? ` · ${rej.reason}${rej.detail ? ` (${rej.detail})` : ''}` : ''} (${ev.address})`
  }
  return `${SPOTLIGHT_SYMBOL}: not evaluated (not a single-source CoinGecko candidate, or pre-filtered on 24h volume)`
}
