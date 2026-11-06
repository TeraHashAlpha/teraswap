/**
 * /api/monitor/alerts — alert delivery status + one-shot test-fire.
 *
 * GET  → which channels are configured (booleans only, never values) and an overall
 *        "OK" | "NOT CONFIGURED". Read by the daily health report.
 * POST → sends ONE clearly-labelled test alert through every configured channel (bypasses dedup and
 *        grace) and reports per channel: sent | skipped (not configured) | failed. Hit it once after
 *        setting the env vars. Throttled to one call per 30 s.
 *
 * Both require `Authorization: Bearer $MONITOR_SECRET` (same secret as GET /api/monitor).
 */

import { NextRequest, NextResponse } from 'next/server'
import { kv } from '@/lib/kv'
import { safeCompare } from '@/lib/validation'
import { bodySizeGuard } from '@/lib/body-limit'
import { getAlertChannelStatus, ALERT_CHANNEL_ENV_NAMES } from '@/lib/alert-channels/status'
import { sendTelegramAlert } from '@/lib/alert-channels/telegram'
import { sendEmailAlert } from '@/lib/alert-channels/email'
import { sendDiscordAlert } from '@/lib/alert-channels/discord'
import type { AlertPayload } from '@/lib/alert-wrapper'

export const dynamic = 'force-dynamic'

const TEST_THROTTLE_KEY = 'teraswap:alert:test-fire-lock'
const TEST_THROTTLE_SECONDS = 30
const NO_STORE = { 'Cache-Control': 'no-store' }

function authorised(req: NextRequest): boolean {
  const header = req.headers.get('authorization')
  const key = header?.startsWith('Bearer ') ? header.slice(7) : null
  const secret = process.env.MONITOR_SECRET
  return Boolean(secret && key && safeCompare(key, secret))
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  const { anyConfigured, ...channels } = getAlertChannelStatus()
  return NextResponse.json(
    { status: anyConfigured ? 'OK' : 'NOT CONFIGURED', channels, envNames: ALERT_CHANNEL_ENV_NAMES },
    { headers: NO_STORE },
  )
}

type ChannelResult = 'sent' | 'skipped (not configured)' | 'failed'

export async function POST(req: NextRequest) {
  const tooLarge = bodySizeGuard(req)
  if (tooLarge) return tooLarge
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  try {
    const acquired = await kv.set(TEST_THROTTLE_KEY, Date.now().toString(), { nx: true, ex: TEST_THROTTLE_SECONDS })
    if (!acquired) {
      return NextResponse.json({ error: 'Test alert already sent in the last 30 s' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(TEST_THROTTLE_SECONDS) } })
    }
  } catch {
    // fail-open: KV down must not stop the operator verifying delivery
  }

  const status = getAlertChannelStatus()
  const payload: AlertPayload = {
    sourceId: 'alert-test',
    from: 'active',
    to: 'active',
    reason: 'TEST ALERT from POST /api/monitor/alerts — if you can read this, alert delivery works. No action needed.',
    timestamp: new Date().toISOString(),
  }

  const send = async (configured: boolean, fn: (p: AlertPayload) => Promise<void>): Promise<ChannelResult> => {
    if (!configured) return 'skipped (not configured)'
    try {
      await fn(payload)
      return 'sent'
    } catch (err) {
      // Class only — upstream error bodies are not echoed back.
      console.error('[ALERT:test] channel delivery failed:', err instanceof Error ? err.message.slice(0, 80) : 'error')
      return 'failed'
    }
  }

  const [telegram, email, discord] = await Promise.all([
    send(status.telegram, sendTelegramAlert),
    send(status.email, sendEmailAlert),
    send(status.discord, sendDiscordAlert),
  ])
  const results = { telegram, email, discord }
  if (!status.anyConfigured) console.error('[ALERT] no delivery channel configured — test alert reached nobody')
  return NextResponse.json({ ok: Object.values(results).includes('sent') && !Object.values(results).includes('failed'), results }, { headers: NO_STORE })
}
