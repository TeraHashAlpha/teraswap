/**
 * POST /api/telegram/webhook — Telegram bot command + callback handler.
 *
 * Receives Telegram Update objects via webhook, parses bot commands
 * (update.message) and inline keyboard button presses (update.callback_query),
 * and responds with monitoring data or executes operator actions.
 *
 * Auth:
 *   - Webhook: X-Telegram-Bot-Api-Secret-Token header verified via
 *     constant-time comparison against TELEGRAM_WEBHOOK_SECRET.
 *   - Admin commands (/disable, /activate, /grace): sender's numeric
 *     Telegram user ID checked against TELEGRAM_ADMIN_IDS allowlist.
 *   - Admin button actions (activate, keep, escalate): same admin check.
 *   - Read-only commands (/status, /quorum, /heartbeat, /help): any user.
 *   - Ack button: any group member.
 *
 * Response model:
 *   Always returns 200 immediately (Telegram retries on non-2xx).
 *   For slow commands (KV reads), we respond 200 OK and send the result
 *   via sendMessage. For callback queries, we call answerCallbackQuery
 *   to dismiss the spinner, then editMessageText to annotate the original.
 *
 * @internal — server-only route.
 */

import { NextResponse } from 'next/server'
import { kv } from '@vercel/kv'
import { timingSafeEqual, createHash } from 'node:crypto'
import {
  beginTick,
  getAllStatuses,
  getStatus,
  getThresholds,
  forceDisable,
  forceActivate,
  type SourceStatus,
} from '@/lib/source-state-machine'
import type { QuorumCheckResult } from '@/lib/quorum-check'
import { escapeHtml } from '@/lib/alert-channels/utils'
import { isP0Reason } from '@/lib/p0-reasons'
import type { AlertPayload } from '@/lib/alert-wrapper'
import { sendTelegramAlert } from '@/lib/alert-channels/telegram'
import { sendEmailAlert } from '@/lib/alert-channels/email'
import { sendDiscordAlert } from '@/lib/alert-channels/discord'

export const dynamic = 'force-dynamic'

// ── Constants ──────────────────────────────────────────

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096
const TELEGRAM_FETCH_TIMEOUT_MS = 5_000
const GRACE_KV_KEY = 'teraswap:monitor:graceUntil'

// ── Telegram types (minimal subset) ────────────────────

interface TelegramUser {
  id: number
  first_name: string
  username?: string
}

interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: { id: number }
  text?: string
}

interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

// ── Callback data types ───────────────────────────────

const CALLBACK_ACTIONS = ['activate', 'keep', 'escalate', 'ack'] as const
type CallbackAction = (typeof CALLBACK_ACTIONS)[number]

/** Admin-only button actions. ack is available to any group member. */
const ADMIN_CALLBACK_ACTIONS: ReadonlySet<string> = new Set(['activate', 'keep', 'escalate'])

export interface ParsedCallback {
  action: CallbackAction
  sourceId: string
}

/** Parse callback_data "action:sourceId". Returns null if invalid. */
export function parseCallbackData(data: string): ParsedCallback | null {
  const colonIdx = data.indexOf(':')
  if (colonIdx < 1) return null
  const action = data.slice(0, colonIdx)
  const sourceId = data.slice(colonIdx + 1)
  if (!sourceId) return null
  if (!CALLBACK_ACTIONS.includes(action as CallbackAction)) return null
  return { action: action as CallbackAction, sourceId }
}

// ── KV audit key prefix ───────────────────────────────

const ACTION_AUDIT_PREFIX = 'teraswap:telegram:action:'

// ── Auth helpers ───────────────────────────────────────

/**
 * Constant-time comparison of webhook secret via SHA-256 hash.
 * Hashing both sides before comparing eliminates the length leak
 * that would otherwise exist with a direct timingSafeEqual on
 * variable-length inputs (the early return on different lengths
 * leaks whether the lengths match).
 */
export function verifyWebhookSecret(provided: string, expected: string): boolean {
  if (!provided || !expected) return false
  try {
    const hashA = createHash('sha256').update(provided).digest()
    const hashB = createHash('sha256').update(expected).digest()
    return timingSafeEqual(hashA, hashB)
  } catch {
    return false
  }
}

function getAdminIds(): number[] {
  const raw = process.env.TELEGRAM_ADMIN_IDS
  if (!raw) return []
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => /^\d+$/.test(s))
    .map(Number)
}

function isAdmin(userId: number): boolean {
  return getAdminIds().includes(userId)
}

// ── Response helpers ───────────────────────────────────

function truncate(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return text
  return text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 4) + '...'
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    signal: AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: truncate(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  }).catch(err => {
    console.error('[TELEGRAM] sendMessage failed:', err instanceof Error ? err.message : err)
  })
}

async function answerCallbackQuery(callbackQueryId: string, text: string, showAlert = false): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return

  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    signal: AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    }),
  }).catch(err => {
    console.error('[TELEGRAM] answerCallbackQuery failed:', err instanceof Error ? err.message : err)
  })
}

async function editMessageText(chatId: number, messageId: number, text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return false

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      signal: AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: truncate(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    return res.ok
  } catch (err) {
    console.error('[TELEGRAM] editMessageText failed:', err instanceof Error ? err.message : err)
    return false
  }
}

// ── Status formatting helpers ──────────────────────────

function stateEmoji(state: string): string {
  if (state === 'active') return '\u{1F7E2}'   // 🟢
  if (state === 'degraded') return '\u{1F7E0}'  // 🟠
  return '\u{1F534}'                             // 🔴
}

function calcP95(history: number[]): number {
  if (history.length === 0) return 0
  const sorted = [...history].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]
}

function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

// ── Command handlers ───────────────────────────────────

async function handleStatus(args: string): Promise<string> {
  beginTick()

  // Single source detail
  if (args) {
    const sourceId = args.toLowerCase()
    const s = await getStatus(sourceId)
    // Check if the source exists in the index
    const allStatuses = await getAllStatuses()
    const exists = allStatuses.some(st => st.id === sourceId)
    if (!exists) {
      return `Source <b>${escapeHtml(sourceId)}</b> not found.`
    }

    const t = getThresholds(sourceId)
    const p95 = calcP95(s.latencyHistory)
    const age = s.lastCheckAt > 0 ? formatAge(Date.now() - s.lastCheckAt) : 'never'

    const lines = [
      `${stateEmoji(s.state)} <b>${escapeHtml(s.id)}</b> — ${s.state.toUpperCase()}`,
      '',
      `<b>Failure count:</b> ${s.failureCount}`,
      `<b>Success count:</b> ${s.successCount}`,
      `<b>Last check:</b> ${age} ago`,
      `<b>P95 latency:</b> ${Math.round(p95)}ms`,
      `<b>Latency (last ${s.latencyHistory.length}):</b> ${s.latencyHistory.map(l => Math.round(l)).join(', ') || 'none'}`,
      '',
      `<b>Thresholds:</b>`,
      `  Failures \u2192 degraded: ${t.failuresToDegraded}`,
      `  Failures \u2192 disabled: ${t.failuresToDisabled}`,
      `  Successes \u2192 active: ${t.successesToActive}`,
      `  P95 threshold: ${t.p95LatencyThresholdMs}ms`,
    ]
    if (s.disabledReason) lines.push(`\n<b>Disabled reason:</b> ${escapeHtml(s.disabledReason)}`)
    if (s.disabledAt) lines.push(`<b>Disabled at:</b> ${new Date(s.disabledAt).toISOString()}`)

    return lines.join('\n')
  }

  // All sources table
  const statuses = await getAllStatuses()
  if (statuses.length === 0) {
    return 'No sources registered.'
  }

  statuses.sort((a, b) => a.id.localeCompare(b.id))

  const header = `<b>\u{1F4CA} Source Status (${statuses.length})</b>\n`
  const rows = statuses.map((s: SourceStatus) => {
    const emoji = stateEmoji(s.state)
    const p95 = Math.round(calcP95(s.latencyHistory))
    const age = s.lastCheckAt > 0 ? formatAge(Date.now() - s.lastCheckAt) : '-'
    const id = s.id.padEnd(14)
    const state = s.state.padEnd(9)
    return `${emoji} ${id} ${state} p95:${p95}ms  ${age}`
  })

  return header + '<pre>' + rows.join('\n') + '</pre>'
}

async function handleQuorum(): Promise<string> {
  try {
    const result = await kv.get<QuorumCheckResult>('teraswap:monitor:lastQuorumResult')
    if (!result) {
      return 'No quorum check data available yet.'
    }

    const lines = [
      `<b>\u{1F50D} Last Quorum Check</b>`,
      `<b>Time:</b> ${result.timestamp}`,
      `<b>Skipped:</b> ${result.skipped ? `Yes \u2014 ${result.skipReason || 'unknown'}` : 'No'}`,
      '',
    ]

    if (!result.skipped) {
      for (const pair of result.pairs) {
        const iqrNote = pair.iqrFiltered && pair.iqrFiltered > 0 ? ` (${pair.iqrFiltered} IQR-filtered)` : ''
        const status = pair.skipped ? `\u26A0\uFE0F skipped (${pair.skipReason || '?'})` : `\u2705 ${pair.quotesCollected} quotes${iqrNote}`
        lines.push(`<b>${escapeHtml(pair.label)}</b>: ${status}`)
        if (!pair.skipped && pair.outliers.length > 0) {
          for (const o of pair.outliers) {
            lines.push(`  ${stateEmoji('disabled')} ${escapeHtml(o.sourceId)}: ${o.deviationPercent}% (${o.classification})`)
          }
        }
      }

      lines.push('')
      if (result.outliers.length === 0) {
        lines.push('\u{1F7E2} All sources within tolerance')
      } else {
        const correlated = result.outliers.filter(o => o.classification === 'correlated').length
        const flagged = result.outliers.filter(o => o.classification === 'flagged').length
        const warnings = result.outliers.filter(o => o.classification === 'warning').length
        lines.push(`\u{1F534} Outliers: ${correlated} correlated, ${flagged} flagged, ${warnings} warning`)
      }
    }

    return lines.join('\n')
  } catch (err) {
    return `Failed to read quorum data: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleHeartbeat(): Promise<string> {
  try {
    const [lastTickIso, tickCount, lastQuorum] = await Promise.all([
      kv.get<string>('teraswap:monitor:lastTick'),
      kv.get<number>('teraswap:monitor:tickCount'),
      kv.get<QuorumCheckResult>('teraswap:monitor:lastQuorumResult'),
    ])

    const lastTickMs = lastTickIso ? new Date(lastTickIso).getTime() : 0
    const ageSeconds = lastTickMs > 0 ? Math.round((Date.now() - lastTickMs) / 1000) : null
    const fresh = ageSeconds !== null && ageSeconds < 180

    const lines = [
      `<b>\u{1F493} Monitoring Heartbeat</b>`,
      '',
      `<b>Last tick:</b> ${lastTickIso || 'never'}`,
      `<b>Tick count:</b> ${tickCount ?? 0}`,
      `<b>Age:</b> ${ageSeconds !== null ? `${ageSeconds}s` : 'N/A'}`,
      `<b>Tick fresh:</b> ${fresh ? '\u2705 yes' : '\u274C no (>180s)'}`,
      '',
      `<b>Last quorum:</b> ${lastQuorum?.timestamp || 'never'}`,
      `<b>Quorum healthy:</b> ${lastQuorum ? (lastQuorum.correlatedOutlierCount === 0 ? '\u2705 yes' : '\u274C no') : 'N/A'}`,
    ]

    return lines.join('\n')
  } catch (err) {
    return `Failed to read heartbeat data: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleDisable(args: string, userId: number): Promise<string> {
  if (!isAdmin(userId)) {
    return `\u26D4 Admin-only command. Your ID: ${userId}`
  }

  const parts = args.split(/\s+/)
  const sourceId = parts[0]
  if (!sourceId) {
    return 'Usage: /disable {sourceId} {reason}\nExample: /disable cowswap suspicious quotes'
  }

  // Verify source exists
  beginTick()
  const allStatuses = await getAllStatuses()
  const exists = allStatuses.some(s => s.id === sourceId.toLowerCase())
  if (!exists) {
    return `Source <b>${escapeHtml(sourceId)}</b> not found.`
  }

  const reason = parts.slice(1).join(' ') || 'operator action'
  // NOT P0 — allows auto-recovery. For permanent P0 disable, use kill-switch endpoint.
  const fullReason = `operator-disable: ${reason}`

  await forceDisable(sourceId.toLowerCase(), fullReason)

  return `\u{1F534} <b>${escapeHtml(sourceId)}</b> disabled.\nReason: ${escapeHtml(fullReason)}\n\n<i>Non-P0 \u2014 auto-recovery after 10 min if healthy.</i>`
}

async function handleActivate(args: string, userId: number): Promise<string> {
  if (!isAdmin(userId)) {
    return `\u26D4 Admin-only command. Your ID: ${userId}`
  }

  const parts = args.split(/\s+/)
  const sourceId = parts[0]
  if (!sourceId) {
    return 'Usage: /activate {sourceId}\nExample: /activate cowswap'
  }

  // Verify source exists
  beginTick()
  const allStatuses = await getAllStatuses()
  const exists = allStatuses.some(s => s.id === sourceId.toLowerCase())
  if (!exists) {
    return `Source <b>${escapeHtml(sourceId)}</b> not found.`
  }

  // P0 confirmation gate: if source was disabled by P0 reason, require explicit "confirm"
  const status = await getStatus(sourceId.toLowerCase())
  if (status.state === 'disabled' && isP0Reason(status.disabledReason)) {
    const hasConfirm = parts[1]?.toLowerCase() === 'confirm'
    if (!hasConfirm) {
      return `\u26A0\uFE0F Source was disabled by P0 reason: <b>${escapeHtml(status.disabledReason || 'unknown')}</b>\nSend <code>/activate ${escapeHtml(sourceId)} confirm</code> to proceed.`
    }
  }

  await forceActivate(sourceId.toLowerCase())

  return `\u{1F7E2} <b>${escapeHtml(sourceId)}</b> activated.\nCounters reset. Source is now active.`
}

async function handleGrace(args: string, userId: number): Promise<string> {
  if (!isAdmin(userId)) {
    return `\u26D4 Admin-only command. Your ID: ${userId}`
  }

  const minutesStr = args.split(/\s+/)[0]
  const minutes = Number(minutesStr)
  if (!minutesStr || !Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    return 'Usage: /grace {minutes}\nRange: 1\u20131440 (24h max)\nExample: /grace 30'
  }

  const graceUntil = new Date(Date.now() + minutes * 60_000).toISOString()

  try {
    await kv.set(GRACE_KV_KEY, graceUntil, { ex: minutes * 60 })
    return `\u23F8\uFE0F Grace period set until <b>${graceUntil}</b> (${minutes} min).\nNon-P0 alerts suppressed. Heartbeat reports healthy.`
  } catch (err) {
    return `Failed to set grace period: ${err instanceof Error ? err.message : String(err)}`
  }
}

function handleHelp(): string {
  return [
    '<b>\u{1F4CB} TeraSwap Monitor Commands</b>',
    '',
    '<b>Read-only (any user):</b>',
    '/status \u2014 All source states',
    '/status {id} \u2014 Detail for one source',
    '/quorum \u2014 Last quorum check',
    '/heartbeat \u2014 Monitoring heartbeat',
    '/help \u2014 This message',
    '',
    '<b>Admin only:</b>',
    '/disable {id} {reason} \u2014 Force-disable source',
    '/activate {id} \u2014 Re-activate source',
    '/grace {minutes} \u2014 Set maintenance grace period',
  ].join('\n')
}

// ── Command router ─────────────────────────────────────

interface ParsedCommand {
  command: string
  args: string
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  // Handle /command@botname format
  const match = trimmed.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s)
  if (!match) return null

  return {
    command: match[1].toLowerCase(),
    args: match[2].trim(),
  }
}

async function routeCommand(
  command: string,
  args: string,
  userId: number,
): Promise<string> {
  switch (command) {
    case 'status':
      return handleStatus(args)
    case 'quorum':
      return handleQuorum()
    case 'heartbeat':
      return handleHeartbeat()
    case 'disable':
      return handleDisable(args, userId)
    case 'activate':
      return handleActivate(args, userId)
    case 'grace':
      return handleGrace(args, userId)
    case 'help':
    case 'start':
      return handleHelp()
    default:
      return `Unknown command: /${escapeHtml(command)}\nType /help for available commands.`
  }
}

// ── Callback query handler ─────────────────────────────

async function logButtonAction(
  action: string,
  sourceId: string,
  userId: number,
  username: string,
): Promise<void> {
  try {
    const timestamp = new Date().toISOString()
    await kv.set(`${ACTION_AUDIT_PREFIX}${timestamp}`, {
      action,
      sourceId,
      userId,
      username,
      timestamp,
    })
  } catch (err) {
    console.warn('[TELEGRAM] Audit trail write failed:', err instanceof Error ? err.message : err)
  }
}

async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const data = query.data
  if (!data) return

  const parsed = parseCallbackData(data)
  if (!parsed) return // stale/invalid button — ignore silently

  const { action, sourceId } = parsed
  const userId = query.from.id
  const username = query.from.username || query.from.first_name || String(userId)
  const chatId = query.message?.chat.id
  const messageId = query.message?.message_id
  const originalText = query.message?.text || ''

  // Admin check for privileged actions
  if (ADMIN_CALLBACK_ACTIONS.has(action) && !isAdmin(userId)) {
    await answerCallbackQuery(query.id, '\u26D4 Admin only', true)
    return
  }

  // Verify source exists
  beginTick()
  const allStatuses = await getAllStatuses()
  const exists = allStatuses.some(s => s.id === sourceId)
  if (!exists) {
    await answerCallbackQuery(query.id, `Source "${sourceId}" not found`, true)
    return
  }

  let answerText: string
  let actionLabel: string

  switch (action) {
    case 'activate': {
      const status = await getStatus(sourceId)
      // Already active — no-op
      if (status.state === 'active') {
        await answerCallbackQuery(query.id, `\u2705 ${sourceId} already active \u2014 no change`)
        await logButtonAction(action, sourceId, userId, username)
        return
      }
      // P0-disabled → redirect to text command for safety
      if (status.state === 'disabled' && isP0Reason(status.disabledReason)) {
        await answerCallbackQuery(
          query.id,
          `\u26A0\uFE0F P0 source \u2014 use /activate ${sourceId} confirm in chat`,
          true,
        )
        return
      }
      await forceActivate(sourceId)
      answerText = `\u2705 ${sourceId} reactivated`
      actionLabel = 'Reactivated'
      break
    }

    case 'keep': {
      // No state change — acknowledgement only
      answerText = `\u{1F512} ${sourceId} kept disabled \u2014 noted`
      actionLabel = 'Kept Disabled'
      break
    }

    case 'escalate': {
      // Re-alert ALL channels directly, bypassing grace + dedup.
      // We fan out to channels here instead of going through emitTransitionAlert
      // because escalation must always fire regardless of grace period or dedup.
      const status = await getStatus(sourceId)
      const escalationPayload: AlertPayload = {
        sourceId,
        from: status.state === 'disabled' ? 'active' : status.state,
        to: status.state,
        reason: `escalation: operator ${username} via button`,
        timestamp: new Date().toISOString(),
      }
      const channels = [
        { name: 'telegram', send: sendTelegramAlert },
        { name: 'email', send: sendEmailAlert },
        { name: 'discord', send: sendDiscordAlert },
      ]
      const results = await Promise.allSettled(
        channels.map(ch =>
          ch.send(escalationPayload).catch(err => {
            console.error(`[ESCALATE:${ch.name}] failed: ${err instanceof Error ? err.message : err}`)
            throw err
          }),
        ),
      )
      const ok = results.filter(r => r.status === 'fulfilled').length
      answerText = `\u{1F6A8} Escalated \u2014 ${ok}/${channels.length} channels notified`
      actionLabel = 'Escalated'
      break
    }

    case 'ack': {
      answerText = `\u{1F44D} Acknowledged by ${username}`
      actionLabel = 'Acknowledged'
      break
    }

    default:
      return
  }

  // Always answer to dismiss spinner
  await answerCallbackQuery(query.id, answerText)

  // Log to audit trail (all actions, including ack)
  await logButtonAction(action, sourceId, userId, username)

  // Edit original message to annotate the action
  if (chatId && messageId) {
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const annotation = `\n\n\u2014 <b>${actionLabel}</b> by ${escapeHtml(username)} at ${timestamp}`
    const editOk = await editMessageText(chatId, messageId, originalText + annotation)
    // If edit fails (e.g., message >48h old), send a new message instead
    if (!editOk) {
      await sendMessage(chatId, `${answerText}\n<i>(Could not update original message)</i>`)
    }
  }
}

// ── POST handler ───────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  // Verify webhook secret (constant-time)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret) {
    console.error('[TELEGRAM] TELEGRAM_WEBHOOK_SECRET not configured')
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  const provided = req.headers.get('x-telegram-bot-api-secret-token') || ''
  if (!verifyWebhookSecret(provided, secret)) {
    // Return 200 to avoid Telegram retries, but log the attempt
    console.warn('[TELEGRAM] Invalid webhook secret')
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  // Parse the update
  let update: TelegramUpdate
  try {
    update = await req.json()
  } catch {
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  // ── Handle callback queries (inline keyboard button presses) ──
  if (update.callback_query) {
    try {
      await handleCallbackQuery(update.callback_query)
    } catch (err) {
      console.error('[TELEGRAM] Callback query error:', err instanceof Error ? err.message : err)
      await answerCallbackQuery(update.callback_query.id, 'Internal error').catch(() => {})
    }
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  // ── Handle text commands ──
  const message = update.message
  if (!message?.text || !message.from) {
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  const parsed = parseCommand(message.text)
  if (!parsed) {
    // Not a command — ignore
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  const chatId = message.chat.id
  const userId = message.from.id

  try {
    const reply = await routeCommand(parsed.command, parsed.args, userId)
    await sendMessage(chatId, reply)
  } catch (err) {
    console.error('[TELEGRAM] Command error:', err instanceof Error ? err.message : err)
    await sendMessage(chatId, 'Internal error processing command.').catch(() => {})
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}
