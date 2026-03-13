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

// Allowed categories — anything else gets rejected
const VALID_CATEGORIES = new Set(['swap', 'approval', 'quote', 'order', 'ui', 'error'])

// Max string lengths to prevent abuse
const MAX_STR = 500
function cap(s: unknown, max = MAX_STR): string | null {
  if (typeof s !== 'string') return null
  return s.slice(0, max) || null
}

/**
 * POST /api/log-activity
 *
 * Lightweight endpoint for per-wallet activity tracking.
 * Accepts a JSON body with one or more events.
 * No auth required — wallet addresses are public on-chain.
 *
 * Body: { events: Array<WalletActivityEvent> }
 */
export async function POST(req: Request) {
  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS }) // silently succeed
  }

  try {
    const body = await req.json()
    const events: unknown[] = Array.isArray(body.events) ? body.events : (body.wallet ? [body] : [])

    if (events.length === 0) {
      return NextResponse.json({ ok: true }, { headers: CORS_HEADERS })
    }

    // Cap at 50 events per batch to prevent abuse
    const batch = events.slice(0, 50)

    const rows = batch
      .filter((e): e is Record<string, unknown> => {
        if (!e || typeof e !== 'object') return false
        const ev = e as Record<string, unknown>
        return typeof ev.wallet === 'string' &&
          typeof ev.category === 'string' &&
          VALID_CATEGORIES.has(ev.category as string) &&
          typeof ev.action === 'string'
      })
      .map(e => ({
        wallet:      (e.wallet as string).toLowerCase().slice(0, 42),
        session_id:  cap(e.session_id, 64),
        category:    cap(e.category, 20),
        action:      cap(e.action, 60),
        source:      cap(e.source, 30),
        token_in:    cap(e.token_in, 20),
        token_out:   cap(e.token_out, 20),
        amount_usd:  typeof e.amount_usd === 'number' ? Math.min(Math.max(0, e.amount_usd), 1_000_000_000) : null,
        success:     typeof e.success === 'boolean' ? e.success : null,
        error_code:  cap(e.error_code, 60),
        error_msg:   cap(e.error_msg, 500),
        tx_hash:     cap(e.tx_hash, 66),
        order_id:    cap(e.order_id, 200),
        duration_ms: typeof e.duration_ms === 'number' ? Math.min(Math.max(0, Math.round(e.duration_ms)), 86_400_000) : null,
        metadata:    (e.metadata && typeof e.metadata === 'object') ? e.metadata : {},
      }))

    if (rows.length > 0) {
      // Fire-and-forget insert — don't block the response
      Promise.resolve(supabase.from('wallet_activity').insert(rows)).catch(() => {})
    }

    return NextResponse.json({ ok: true, count: rows.length }, { headers: CORS_HEADERS })
  } catch {
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS })
  }
}
