import { NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'

// CORS — allow any origin (client-side tracker posts from the same domain,
// but we keep * for local dev / preview deploys).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

// Allowed event types — anything else gets rejected
const VALID_TYPES = new Set(['page_view', 'click', 'session_end'])

// Max string lengths to prevent abuse
const MAX_STR = 500
function cap(s: unknown, max = MAX_STR): string | null {
  if (typeof s !== 'string') return null
  return s.slice(0, max) || null
}

/**
 * POST /api/log-event
 *
 * Lightweight endpoint for usage tracking.
 * Accepts a JSON body with one or more events.
 * No auth required — this is public fire-and-forget telemetry.
 *
 * Body: { events: Array<UsageEvent> }
 */
export async function POST(req: Request) {
  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS }) // silently succeed
  }

  try {
    const body = await req.json()
    const events: unknown[] = Array.isArray(body.events) ? body.events : (body.event_type ? [body] : [])

    if (events.length === 0) {
      return NextResponse.json({ ok: true }, { headers: CORS_HEADERS })
    }

    // Cap at 50 events per batch to prevent abuse
    const batch = events.slice(0, 50)

    const rows = batch
      .filter((e): e is Record<string, unknown> => {
        if (!e || typeof e !== 'object') return false
        const ev = e as Record<string, unknown>
        return typeof ev.session_id === 'string' &&
          typeof ev.event_type === 'string' &&
          VALID_TYPES.has(ev.event_type as string) &&
          typeof ev.page === 'string'
      })
      .map(e => ({
        session_id:    cap(e.session_id, 64),
        event_type:    cap(e.event_type, 20),
        page:          cap(e.page, 200),
        referrer:      cap(e.referrer, 500),
        click_target:  cap(e.click_target, 200),
        click_tag:     cap(e.click_tag, 30),
        click_id:      cap(e.click_id, 100),
        click_class:   cap(e.click_class, 100),
        duration_ms:   typeof e.duration_ms === 'number' ? Math.min(Math.max(0, Math.round(e.duration_ms)), 86_400_000) : null,
        screen_w:      typeof e.screen_w === 'number' ? Math.min(Math.max(0, Math.round(e.screen_w)), 10000) : null,
        user_agent:    cap(e.user_agent, 500),
      }))

    if (rows.length > 0) {
      // Fire-and-forget insert — don't block the response
      Promise.resolve(supabase.from('usage_events').insert(rows)).catch(() => {})
    }

    return NextResponse.json({ ok: true, count: rows.length }, { headers: CORS_HEADERS })
  } catch {
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS })
  }
}
