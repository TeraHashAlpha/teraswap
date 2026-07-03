/**
 * [CHORE-QUOTE-QUORUM / W7-L-02] Source-health monitoring + rate-limited alerts
 * (SERVER-ONLY).
 *
 * The T-SAF W7-L-02 coverage check found that Balancer 404-ing forever,
 * OpenOcean emitting 10^n-mis-scaled quotes, and Odos going from 614 quotes/17%
 * wins to silent were ALL invisible until an adversarial audit. A
 * meta-aggregator's value IS source breadth — a dead/garbage/silent source must
 * page. Three detectors run over the monitor's rolling quote window:
 *
 *   - silence  (Balancer/Odos class): a baselined — historically-quoting —
 *     source has 0 quotes in the window (or is absent entirely).
 *   - outlier  (OpenOcean class): a source's quotes keep being demoted/dropped
 *     from the DISPLAY (3×-median filter or the low-quorum band from
 *     quote-quorum.ts). Those drops are exactly the quotes H5's quorum-check
 *     never sees (it reads the post-filter result), so this counter is the only
 *     signal that a source is systematically mis-scaled.
 *   - drift: a baselined source's windowed win rate collapsed to below
 *     DRIFT_WIN_COLLAPSE_FACTOR × its baseline on a meaningful sample.
 *
 * Baselines: the sources that CURRENTLY quote in production plus their typical
 * win rates from the monitor history (Audits/Daily health tables, Apr–Jul 2026;
 * see Audits/Campaign/2026-07-01/W7-followup-silent-sources.md). The known-
 * silent five (1inch/0x/odos/sushiswap/bebop — env-key + request-shape causes)
 * and disabled sources (balancer) are deliberately NOT baselined: alerting on a
 * condition that is already diagnosed and awaiting an owner fix every window is
 * noise. ADD a source here the day its fix lands — from then on a relapse pages.
 *
 * Alerting mirrors cow-fee-monitor (W7-L-01): the serverless #201-equivalent
 * fan-out via emitTransitionAlert with the informational from='active'
 * to='active' convention, rate-limited to ONE alert per source·kind per window
 * via a KV SET NX + EX key. Every path fails OPEN — monitoring must never break
 * the monitor endpoint or the quote path.
 *
 * Reconciliation (no double-alerting):
 *   - H5 quorum-check flags/disables a source deviating on REFERENCE pairs; it
 *     alerts through state-machine transitions. Ours are informational
 *     non-transition alerts keyed per source·kind, driven by real-traffic
 *     windows — complementary, different trigger data.
 *   - #248 (DCA deviation guard) defers keeper EXECUTIONS; its alerts are
 *     keeper-side (#201) about orders, never about source fleet health.
 *   - #18/#247 (oracle-less advisory) is a client display advisory; it never
 *     alerts.
 */
import { kv } from '@/lib/kv'
import { emitTransitionAlert } from '@/lib/alert-wrapper'

/** One alert per source·kind per this window (seconds). Source death is not
 *  sub-hourly actionable; 6 h keeps a persistent condition visible without spam. */
export const SOURCE_HEALTH_ALERT_WINDOW_SECONDS = 6 * 3600

/** Display demotions/drops within the window that mean "systematically
 *  mis-scaled", not a one-off race: ~10 covers minutes of quoting, while a
 *  single volatile-market drop stays silent. */
export const OUTLIER_DROP_ALERT_THRESHOLD = 10

/** Minimum windowed quote sample before win-rate drift is judged (below this a
 *  quiet market produces meaningless rates). */
export const DRIFT_MIN_SAMPLE = 20

/** Drift fires when windowed winRate < baseline × this factor (0.25 ⇒ a
 *  collapse to under a quarter of the source's typical rate). */
export const DRIFT_WIN_COLLAPSE_FACTOR = 0.25

/**
 * Historically-quoting sources and their typical win rates (percent), from the
 * daily monitor history Apr–Jul 2026. quote presence expected every window.
 * Deliberately EXCLUDED until their fixes land (see module doc): 1inch, 0x,
 * odos, sushiswap, bebop (silent — W7 follow-up), balancer (DISABLED_SOURCES),
 * curve/openocean (quote-only trickle, n≈2 windows — no stable baseline).
 */
export const SOURCE_HEALTH_BASELINES: Record<string, { typicalWinRatePercent: number }> = {
  kyberswap: { typicalWinRatePercent: 55 },
  velora: { typicalWinRatePercent: 30 },
  cowswap: { typicalWinRatePercent: 2 },
  uniswapv3: { typicalWinRatePercent: 4 },
}

const OUTLIER_COUNTER_PREFIX = 'teraswap:source-health:display-drop:'
const ALERT_NX_PREFIX = 'teraswap:source-health:alerted:'

export interface SourceHealthSnapshot {
  source: string
  quoteCount: number
  winCount: number
}

export interface SourceHealthFinding {
  source: string
  kind: 'silence' | 'outlier' | 'drift'
  detail: string
}

/**
 * Pure detector: snapshots are the monitor's windowed per-source rows;
 * `outlierDrops` is the per-source display-drop counter readout for the window.
 */
export function detectSourceHealthFindings(
  snapshots: SourceHealthSnapshot[],
  outlierDrops: Record<string, number>,
): SourceHealthFinding[] {
  const findings: SourceHealthFinding[] = []
  const bySource = new Map(snapshots.map(s => [s.source, s]))

  for (const [source, baseline] of Object.entries(SOURCE_HEALTH_BASELINES)) {
    const snapshot = bySource.get(source)
    const quoteCount = snapshot?.quoteCount ?? 0

    if (quoteCount === 0) {
      findings.push({
        source,
        kind: 'silence',
        detail: `historically-quoting source produced 0 quotes in the window (baseline win rate ~${baseline.typicalWinRatePercent}%)`,
      })
      continue // win-rate drift is meaningless with no quotes
    }

    if (quoteCount >= DRIFT_MIN_SAMPLE) {
      const winRatePercent = (snapshot!.winCount / quoteCount) * 100
      const floor = baseline.typicalWinRatePercent * DRIFT_WIN_COLLAPSE_FACTOR
      if (winRatePercent < floor) {
        findings.push({
          source,
          kind: 'drift',
          detail:
            `win rate collapsed to ${winRatePercent.toFixed(1)}% over ${quoteCount} quotes ` +
            `(baseline ~${baseline.typicalWinRatePercent}%, alert floor ${floor.toFixed(1)}%)`,
        })
      }
    }
  }

  for (const [source, drops] of Object.entries(outlierDrops)) {
    if (drops >= OUTLIER_DROP_ALERT_THRESHOLD) {
      findings.push({
        source,
        kind: 'outlier',
        detail:
          `${drops} quotes demoted/dropped from the display in the window ` +
          `(≥${OUTLIER_DROP_ALERT_THRESHOLD} ⇒ systematic mis-scale/units defect, the OpenOcean class)`,
      })
    }
  }

  return findings
}

/**
 * Record one display demotion/drop for `source` (called fire-and-forget from
 * the quote-selection drop sites). INCR + first-write TTL = fixed-window
 * counter, the cow-fee-monitor pattern. Fail-open.
 */
export async function recordQuoteDisplayDrop(source: string): Promise<void> {
  try {
    const count = await kv.incr(`${OUTLIER_COUNTER_PREFIX}${source}`)
    if (count === 1) await kv.expire(`${OUTLIER_COUNTER_PREFIX}${source}`, SOURCE_HEALTH_ALERT_WINDOW_SECONDS)
  } catch (err) {
    console.warn('[source-health] drop-record failed (ignored):', err instanceof Error ? err.message : err)
  }
}

/** Read the windowed display-drop counters for the sources we may alert on. */
async function readOutlierDrops(snapshots: SourceHealthSnapshot[]): Promise<Record<string, number>> {
  const sources = Array.from(
    new Set([...snapshots.map(s => s.source), ...Object.keys(SOURCE_HEALTH_BASELINES)]),
  )
  const drops: Record<string, number> = {}
  await Promise.all(
    sources.map(async source => {
      try {
        const raw = await kv.get<number | string>(`${OUTLIER_COUNTER_PREFIX}${source}`)
        const n = Number(raw)
        if (Number.isFinite(n) && n > 0) drops[source] = n
      } catch { /* fail-open per source */ }
    }),
  )
  return drops
}

/**
 * Detect findings over the monitor's windowed snapshots and emit ONE
 * rate-limited informational alert per source·kind per window. Returns the
 * findings so the monitor response can surface them. Fail-open everywhere.
 */
export async function checkSourceHealthAlerts(
  snapshots: SourceHealthSnapshot[],
): Promise<SourceHealthFinding[]> {
  let findings: SourceHealthFinding[] = []
  try {
    const outlierDrops = await readOutlierDrops(snapshots)
    findings = detectSourceHealthFindings(snapshots, outlierDrops)

    for (const finding of findings) {
      try {
        // SET NX + EX ⇒ exactly one alert per source·kind per window (the CoW
        // fee-zero alert's rate-limit shape, keyed per finding).
        const acquired = await kv.set(
          `${ALERT_NX_PREFIX}${finding.source}:${finding.kind}`,
          new Date().toISOString(),
          { nx: true, ex: SOURCE_HEALTH_ALERT_WINDOW_SECONDS },
        )
        if (acquired !== 'OK') continue

        const kindLabel =
          finding.kind === 'silence' ? 'SILENT (death/silence)' :
          finding.kind === 'outlier' ? 'SYSTEMATIC DISPLAY OUTLIER (mis-scale/units)' :
          'WIN-RATE DRIFT'
        // Informational alert — from='active' to='active' is the established
        // non-transition convention (kv-failure + cow-fee-zero alerts).
        await emitTransitionAlert(
          finding.source,
          'active',
          'active',
          `Source health: ${finding.source} is ${kindLabel} — ${finding.detail}. ` +
            `Windowed check from /api/monitor; next alert for this condition in ` +
            `${Math.round(SOURCE_HEALTH_ALERT_WINDOW_SECONDS / 3600)} h if unresolved. ` +
            `Playbook: Audits/Campaign/2026-07-01/W7-followup-silent-sources.md`,
        )
      } catch (err) {
        console.warn('[source-health] alert failed (ignored):', err instanceof Error ? err.message : err)
      }
    }
  } catch (err) {
    console.warn('[source-health] check failed (ignored):', err instanceof Error ? err.message : err)
  }
  return findings
}
