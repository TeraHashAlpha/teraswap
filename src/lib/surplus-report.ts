/**
 * Weekly surplus report — Sprint 16B / P119.
 *
 * Queries Supabase for the last 7 days of confirmed swaps grouped by source,
 * formats a Telegram message with surplus totals, and posts it to the ops
 * channel. Triggered from the monitoring tick on Sundays at 00:xx UTC, with
 * a KV-backed dedup flag so the report only fires once per ISO week.
 *
 * ADR-006 § Pre-build instrumentation — drives the 30-day decision on whether
 * to build FeeCollector V3 (build if monthly capturable > $500, defer otherwise).
 *
 * @internal — server-only module. Called by runMonitoringTick().
 */

import { kv } from './kv'
import { getSupabase } from './supabase'

// ── Tunables ─────────────────────────────────────────────

/** KV flag — value is the ISO date string of the last sent report. */
const LAST_SENT_KEY = 'teraswap:surplus-report:last-sent'

/** TTL for the dedup flag (longer than a week so it survives multi-week gaps). */
const LAST_SENT_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

/** Window queried (matches the spec's "7 days"). */
const WINDOW_DAYS = 7

/** Monthly revenue projection at the assumed capture rate (ADR-006). */
const CAPTURE_RATE = 0.30

/** Fire only on Sundays at 00:xx UTC (00:00–00:59 UTC). */
const TRIGGER_DOW = 0 // Sunday
const TRIGGER_HOUR = 0

// ── Types ────────────────────────────────────────────────

export interface SurplusRow {
  source: string
  /** Total confirmed swaps in window. */
  swaps: number
  /** Swaps with mev_savings_actual > 0. */
  withSurplus: number
  /** Sum of mev_savings_actual (bigint serialised as string — wei). */
  totalSurplusWei: string
  /** Average of mev_savings_actual over rows with surplus only (bigint string). */
  avgSurplusWei: string
}

export interface SurplusReport {
  windowDays: number
  generatedAt: string
  rows: SurplusRow[]
  /** True when the query succeeded but returned 0 confirmed rows. */
  empty: boolean
}

// ── Query ────────────────────────────────────────────────

/**
 * Pull the last `WINDOW_DAYS` of confirmed swaps and aggregate by source.
 * Aggregation happens in JS rather than Postgres because the Supabase
 * JS client doesn't expose GROUP BY directly without an RPC, and a weekly
 * window contains a small number of rows.
 */
export async function generateSurplusReport(): Promise<SurplusReport> {
  const supabase = getSupabase()
  const generatedAt = new Date().toISOString()
  if (!supabase) {
    return { windowDays: WINDOW_DAYS, generatedAt, rows: [], empty: true }
  }

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('swaps')
    .select('source, mev_savings_actual')
    .eq('status', 'confirmed')
    .gt('created_at', cutoff)

  if (error || !data) {
    return { windowDays: WINDOW_DAYS, generatedAt, rows: [], empty: true }
  }

  type Bucket = { swaps: number; withSurplus: number; total: bigint; surplusSum: bigint }
  const buckets = new Map<string, Bucket>()

  for (const row of data as Array<{ source: string; mev_savings_actual: string | number | null }>) {
    const src = row.source || 'unknown'
    const bucket = buckets.get(src) ?? { swaps: 0, withSurplus: 0, total: 0n, surplusSum: 0n }
    bucket.swaps += 1
    const raw = row.mev_savings_actual
    if (raw != null) {
      let asBig: bigint | null = null
      try {
        asBig = typeof raw === 'string' ? BigInt(raw) : BigInt(Math.trunc(raw))
      } catch {
        asBig = null
      }
      if (asBig != null && asBig > 0n) {
        bucket.total += asBig
        bucket.surplusSum += asBig
        bucket.withSurplus += 1
      }
    }
    buckets.set(src, bucket)
  }

  const rows: SurplusRow[] = Array.from(buckets.entries()).map(([source, b]) => ({
    source,
    swaps: b.swaps,
    withSurplus: b.withSurplus,
    totalSurplusWei: b.total.toString(),
    avgSurplusWei: b.withSurplus > 0 ? (b.surplusSum / BigInt(b.withSurplus)).toString() : '0',
  }))

  // Sort: rows with surplus first by total descending, then by swap count.
  rows.sort((a, b) => {
    const aT = BigInt(a.totalSurplusWei)
    const bT = BigInt(b.totalSurplusWei)
    if (aT !== bT) return aT > bT ? -1 : 1
    return b.swaps - a.swaps
  })

  return {
    windowDays: WINDOW_DAYS,
    generatedAt,
    rows,
    empty: rows.length === 0,
  }
}

// ── Formatting ───────────────────────────────────────────

/**
 * Format a SurplusReport as a Telegram HTML message.
 * Empty reports get a short "no data" line so we still confirm the cron ran.
 */
export function formatSurplusReportMessage(report: SurplusReport): string {
  if (report.empty || report.rows.length === 0) {
    return [
      '\u{1F4CA} <b>Weekly Surplus Report</b>',
      `<i>Window: ${report.windowDays} days · ${report.generatedAt}</i>`,
      '',
      'No surplus data this week.',
    ].join('\n')
  }

  const lines: string[] = []
  lines.push('\u{1F4CA} <b>Weekly Surplus Report</b>')
  lines.push(`<i>Window: ${report.windowDays} days · ${report.generatedAt}</i>`)
  lines.push('')

  let totalSurplusWei = 0n
  for (const row of report.rows) {
    totalSurplusWei += BigInt(row.totalSurplusWei)
    const pctWithSurplus = row.swaps > 0
      ? ((row.withSurplus / row.swaps) * 100).toFixed(1)
      : '0.0'
    lines.push(
      `<code>${row.source.padEnd(12)}</code> ` +
      `swaps=${row.swaps} ` +
      `surplus=${row.withSurplus} (${pctWithSurplus}%) ` +
      `total=${row.totalSurplusWei} wei`,
    )
  }

  // Monthly projection at capture rate. Wei values are kept as strings because
  // they may overflow Number — we just report wei totals here; the operator
  // converts to USD using on-chain prices for the specific tokens involved.
  const monthly = (totalSurplusWei * (30n * 100n)) / (BigInt(report.windowDays) * 100n)
  const captureMonthly = (monthly * BigInt(Math.round(CAPTURE_RATE * 10_000))) / 10_000n

  lines.push('')
  lines.push(`<b>Total weekly surplus:</b> ${totalSurplusWei.toString()} wei (output-token)`)
  lines.push(`<b>Projected monthly @ ${(CAPTURE_RATE * 100).toFixed(0)}% capture:</b> ${captureMonthly.toString()} wei`)
  lines.push('')
  lines.push('<i>ADR-006 § Pre-build instrumentation</i>')

  return lines.join('\n')
}

// ── Telegram delivery ────────────────────────────────────

/**
 * Send a raw HTML message to the ops Telegram chat.
 * Returns true on success, false on missing config or HTTP failure.
 * Never throws — analytics is best-effort.
 */
async function sendTelegramMessage(text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!botToken || !chatId) {
    console.warn('[SURPLUS-REPORT] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping')
    return false
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      signal: AbortSignal.timeout(10_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '?')
      console.warn(`[SURPLUS-REPORT] Telegram ${res.status}: ${body}`)
      return false
    }
    return true
  } catch (err) {
    console.warn('[SURPLUS-REPORT] Telegram send failed:', err instanceof Error ? err.message : err)
    return false
  }
}

// ── Cron trigger ─────────────────────────────────────────

/**
 * Compute the ISO week identifier (YYYY-Www) for a given date. Used as the
 * KV dedup key so we only ever send one report per week, regardless of how
 * many ticks fall into the Sunday-00:xx-UTC window.
 */
export function isoWeek(d: Date): string {
  // Copy and align to Thursday (ISO 8601 week is defined relative to Thursday)
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (dt.getUTCDay() + 6) % 7 // Mon=0..Sun=6
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4))
  const diff = (dt.getTime() - firstThursday.getTime()) / 86_400_000
  const week = 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${dt.getUTCFullYear()}-W${week.toString().padStart(2, '0')}`
}

/**
 * Decide whether to fire the weekly report on this tick. Returns true only
 * when:
 *   - now is Sunday and the UTC hour is TRIGGER_HOUR (one-hour firing window)
 *   - we haven't already sent the report this ISO week (KV dedup)
 *
 * The dedup write happens via the caller after a successful send so a failed
 * send retries on the next tick within the same hour.
 */
export async function shouldSendWeeklyReport(now: Date = new Date()): Promise<boolean> {
  if (now.getUTCDay() !== TRIGGER_DOW) return false
  if (now.getUTCHours() !== TRIGGER_HOUR) return false
  try {
    const last = await kv.get<string>(LAST_SENT_KEY)
    if (last && last === isoWeek(now)) return false
  } catch (err) {
    // KV unreachable → fail-closed (avoid duplicate reports on KV outage).
    console.warn('[SURPLUS-REPORT] KV read failed, deferring:', err instanceof Error ? err.message : err)
    return false
  }
  return true
}

/**
 * Top-level entry point — called from runMonitoringTick.
 * Fire-and-forget: never throws, never delays the tick.
 *
 * Returns true when a report was successfully sent (used by tests).
 */
export async function maybeSendWeeklyReport(now: Date = new Date()): Promise<boolean> {
  try {
    if (!(await shouldSendWeeklyReport(now))) return false

    const report = await generateSurplusReport()
    const text = formatSurplusReportMessage(report)
    const ok = await sendTelegramMessage(text)

    if (ok) {
      try {
        await kv.set(LAST_SENT_KEY, isoWeek(now), { ex: LAST_SENT_TTL_SECONDS })
      } catch (err) {
        console.warn('[SURPLUS-REPORT] KV write failed:', err instanceof Error ? err.message : err)
      }
    }
    return ok
  } catch (err) {
    console.warn('[SURPLUS-REPORT] unexpected error:', err instanceof Error ? err.message : err)
    return false
  }
}
