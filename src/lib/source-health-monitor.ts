/**
 * [CHORE-QUOTE-QUORUM / W7-L-02, fix/source-health-relative-baselines] Source-
 * health monitoring + rate-limited alerts (SERVER-ONLY).
 *
 * The T-SAF W7-L-02 coverage check found that Balancer 404-ing forever,
 * OpenOcean emitting 10^n-mis-scaled quotes, and Odos going from 614 quotes/17%
 * wins to silent were ALL invisible until an adversarial audit. A
 * meta-aggregator's value IS source breadth — a dead/garbage/silent source must
 * page. Three detectors run over the monitor's rolling quote window:
 *
 *   - silence  (Balancer/Odos class): a source that HAS recently quoted
 *     (tracked live via kv, not a frozen list — see below) has 0 quotes in the
 *     current window (or is absent entirely).
 *   - outlier  (OpenOcean class): a source's quotes keep being demoted/dropped
 *     from the DISPLAY (3×-median filter or the low-quorum band from
 *     quote-quorum.ts). Those drops are exactly the quotes H5's quorum-check
 *     never sees (it reads the post-filter result), so this counter is the only
 *     signal that a source is systematically mis-scaled.
 *   - drift (dead-weight class): a source quoting at or above DRIFT_MIN_SAMPLE
 *     with ZERO wins for DRIFT_ZERO_WIN_STREAK_WINDOWS consecutive windows.
 *
 * IMPORTANT — win rate is ZERO-SUM: every window's wins sum to the quote count
 * (each quote has exactly one winner), so one source's win-rate rise is
 * mechanically another source's fall. A 2026-08-24 production window measured
 * kyberswap -45%, velora -26%, uniswapv3 -87% off a frozen SOURCE_HEALTH_
 * BASELINES table simultaneously, purely because 425 wins moved to openocean
 * and sushiswap — two sources the table didn't even model (42.5% of all wins
 * were outside the old detector's view entirely). NONE of that was a source
 * defect. Any future check that compares a source's win rate to a fixed
 * literal (baseline table, percentage floor, etc.) — or to any OTHER source's
 * rate — reintroduces this exact false-positive class, because a healthy
 * field reshuffling shares is indistinguishable from a degrading source under
 * that comparison. The only field-independent signal a source's win rate can
 * give on its own is "it quotes plenty and NEVER wins" (see drift below); that
 * doesn't depend on what anyone else is doing.
 *
 * "Historically-quoting" for silence purposes is NOT a frozen per-source list
 * (see git history for the SOURCE_HEALTH_BASELINES table this replaced — it
 * silently excluded openocean/sushiswap because their fixes landed after the
 * table was written). It's tracked live: any source seen quoting has a kv flag
 * refreshed with a SOURCE_KNOWN_QUOTING_TTL_SECONDS TTL. A source that
 * genuinely stops for good (deliberately disabled, vendor shutdown) ages out
 * of "known quoting" on its own after the TTL and stops paging — no manual
 * table edit required to silence a resolved/permanent condition.
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

/** Minimum windowed quote sample before a source's own win rate is judged
 *  (below this a quiet market produces meaningless rates). */
export const DRIFT_MIN_SAMPLE = 20

/** Consecutive /api/monitor windows (monitoring-watchdog cron runs every 5 min
 *  — .github/workflows/monitoring-watchdog.yml) a source must quote >=
 *  DRIFT_MIN_SAMPLE and win ZERO times before it's reported as dead weight.
 *  K=3 ⇒ ~15 min of confirmed zero wins on a qualifying sample: long enough
 *  that a single unlucky/quiet-market window can't false-page, short enough
 *  to alert well inside the 6 h SOURCE_HEALTH_ALERT_WINDOW_SECONDS dedup. This
 *  check is field-independent — it never compares one source's rate to
 *  another's or to a fixed baseline (see module doc: win rate is zero-sum). */
export const DRIFT_ZERO_WIN_STREAK_WINDOWS = 3

/** How long a source stays "known quoting" (silence-eligible) after its last
 *  window with quotes > 0. 7 days gives ample time to notice/escalate a
 *  genuine regression (well past the 6 h alert dedup) while letting a
 *  deliberately-disabled or permanently-shut-down source stop paging on its
 *  own once nobody's expecting it to quote anymore. */
export const SOURCE_KNOWN_QUOTING_TTL_SECONDS = 7 * 24 * 3600

/** How long a source's consecutive-zero-win streak counter survives between
 *  windows. Generous relative to the ~5 min monitor cadence so a delayed or
 *  occasionally-missed watchdog tick doesn't spuriously reset a real streak;
 *  still bounded so a long-idle counter doesn't linger forever. */
const ZERO_WIN_STREAK_TTL_SECONDS = 24 * 3600

const OUTLIER_COUNTER_PREFIX = 'teraswap:source-health:display-drop:'
const ALERT_NX_PREFIX = 'teraswap:source-health:alerted:'
const KNOWN_SOURCES_SET_KEY = 'teraswap:source-health:known-sources'
const KNOWN_QUOTING_PREFIX = 'teraswap:source-health:known-quoting:'
const ZERO_WIN_STREAK_PREFIX = 'teraswap:source-health:zero-win-streak:'

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

/** Per-source state carried across windows via kv, read before detection and
 *  written after (see readTrailingHistory / writeTrailingHistory). Passed into
 *  the pure detector so tests can drive it without touching kv. */
export interface SourceTrailingHistory {
  /** This source has quoted (quoteCount > 0) within the last
   *  SOURCE_KNOWN_QUOTING_TTL_SECONDS — i.e. it's currently expected to quote. */
  knownQuoting: boolean
  /** Consecutive PRIOR windows (not including the current one) where this
   *  source quoted >= DRIFT_MIN_SAMPLE and won zero. */
  priorZeroWinStreak: number
}

/**
 * Pure detector: snapshots are the monitor's windowed per-source rows;
 * `outlierDrops` is the per-source display-drop counter readout for the
 * window; `trailingHistory` is each observed-or-previously-known source's
 * carried-over state (see SourceTrailingHistory). No baseline literal, no
 * cross-source comparison — every check is either about THIS source's own
 * history or purely structural (present/absent, drop count).
 */
export function detectSourceHealthFindings(
  snapshots: SourceHealthSnapshot[],
  outlierDrops: Record<string, number>,
  trailingHistory: Record<string, SourceTrailingHistory> = {},
): SourceHealthFinding[] {
  const findings: SourceHealthFinding[] = []
  const bySource = new Map(snapshots.map(s => [s.source, s]))

  // ── silence: a source we currently expect to quote (per live kv tracking,
  // not a frozen list) produced 0 quotes this window. ──
  const silenceCandidates = new Set([
    ...Object.keys(trailingHistory),
    ...snapshots.map(s => s.source),
  ])
  for (const source of silenceCandidates) {
    if (!trailingHistory[source]?.knownQuoting) continue
    const quoteCount = bySource.get(source)?.quoteCount ?? 0
    if (quoteCount === 0) {
      findings.push({
        source,
        kind: 'silence',
        detail: 'previously-quoting source produced 0 quotes in the window',
      })
    }
  }

  // ── drift (dead weight): quotes plenty, wins nothing, for K windows
  // running. Field-independent — never compares against another source or a
  // fixed rate (win rate is zero-sum, see module doc). ──
  for (const snapshot of snapshots) {
    if (snapshot.quoteCount < DRIFT_MIN_SAMPLE || snapshot.winCount !== 0) continue
    const priorStreak = trailingHistory[snapshot.source]?.priorZeroWinStreak ?? 0
    const streak = priorStreak + 1
    if (streak >= DRIFT_ZERO_WIN_STREAK_WINDOWS) {
      findings.push({
        source: snapshot.source,
        kind: 'drift',
        detail:
          `${snapshot.quoteCount} quotes (>= sample floor ${DRIFT_MIN_SAMPLE}) with ZERO wins across ` +
          `${streak} consecutive windows — dead weight regardless of what other sources are winning`,
      })
    }
  }

  // ── outlier: display-drop counter reached the threshold (unchanged). ──
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
  const sources = Array.from(new Set(snapshots.map(s => s.source)))
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
 * Read each observed-or-previously-known source's carried-over state
 * (knownQuoting flag + zero-win streak) from kv. `KNOWN_SOURCES_SET_KEY` is an
 * append-only registry (SADD, never pruned — cardinality is bounded by the
 * fleet size) so silence can be evaluated for a source that's gone completely
 * absent from the current window, not just ones present in it.
 */
async function readTrailingHistory(
  snapshots: SourceHealthSnapshot[],
): Promise<Record<string, SourceTrailingHistory>> {
  const history: Record<string, SourceTrailingHistory> = {}
  try {
    const known = (await kv.smembers(KNOWN_SOURCES_SET_KEY)) as string[]
    const sources = Array.from(new Set([...known, ...snapshots.map(s => s.source)]))
    await Promise.all(
      sources.map(async source => {
        try {
          const [quoting, streakRaw] = await Promise.all([
            kv.get(`${KNOWN_QUOTING_PREFIX}${source}`),
            kv.get<number | string>(`${ZERO_WIN_STREAK_PREFIX}${source}`),
          ])
          const streak = Number(streakRaw)
          history[source] = {
            knownQuoting: quoting !== null,
            priorZeroWinStreak: Number.isFinite(streak) && streak > 0 ? streak : 0,
          }
        } catch {
          history[source] = { knownQuoting: false, priorZeroWinStreak: 0 } // fail-open per source
        }
      }),
    )
  } catch (err) {
    console.warn('[source-health] trailing-history read failed (ignored):', err instanceof Error ? err.message : err)
  }
  return history
}

/**
 * Persist this window's observations for next time: mark quoting sources as
 * "known quoting" (refreshes the silence-eligibility TTL) and advance/reset
 * each source's zero-win streak. Fail-open, best-effort per source.
 */
async function writeTrailingHistory(snapshots: SourceHealthSnapshot[]): Promise<void> {
  await Promise.all(
    snapshots.map(async snapshot => {
      try {
        if (snapshot.quoteCount > 0) {
          await kv.sadd(KNOWN_SOURCES_SET_KEY, snapshot.source)
          await kv.set(`${KNOWN_QUOTING_PREFIX}${snapshot.source}`, '1', { ex: SOURCE_KNOWN_QUOTING_TTL_SECONDS })
        }

        const key = `${ZERO_WIN_STREAK_PREFIX}${snapshot.source}`
        if (snapshot.quoteCount >= DRIFT_MIN_SAMPLE && snapshot.winCount === 0) {
          const count = await kv.incr(key)
          if (count === 1) await kv.expire(key, ZERO_WIN_STREAK_TTL_SECONDS)
        } else {
          await kv.del(key)
        }
      } catch (err) {
        console.warn('[source-health] trailing-history write failed (ignored):', err instanceof Error ? err.message : err)
      }
    }),
  )
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
    const [outlierDrops, trailingHistory] = await Promise.all([
      readOutlierDrops(snapshots),
      readTrailingHistory(snapshots),
    ])
    findings = detectSourceHealthFindings(snapshots, outlierDrops, trailingHistory)
    await writeTrailingHistory(snapshots)

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
          'DEAD WEIGHT (zero wins on a qualifying sample)'
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
