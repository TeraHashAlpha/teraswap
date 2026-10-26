/**
 * [ADR-025] POST /api/admin/ui-version {version: 'v1' | 'v2'} — owner-only UI switch.
 *
 * Same admin gate as /api/admin/dca-freeze and /kill-switch: Bearer token, constant-time compared via
 * verifyBearerToken, secret from UI_V2_ADMIN_SECRET (503 unset / 401 bad token). 'v2' sets the signed
 * `ts_ui` cookie (HttpOnly, Secure, SameSite=Lax, 30 d); 'v1' clears it. Call it from the browser
 * (same-origin fetch) so the Set-Cookie lands in that browser.
 */
import { NextRequest, NextResponse } from 'next/server'
import { bodySizeGuard } from '@/lib/body-limit'
import { verifyBearerToken } from '@/lib/auth'
import { UI_COOKIE_MAX_AGE_S, UI_COOKIE_NAME, signUiVersionCookie } from '@/ui/v2/ui-cookie'

export const dynamic = 'force-dynamic'

const COOKIE_BASE = {
  name: UI_COOKIE_NAME,
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
}

function authorize(req: NextRequest): NextResponse | null {
  const secret = process.env.UI_V2_ADMIN_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'ui-version not configured' }, { status: 503 })
  }
  if (!verifyBearerToken(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return null
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const tooLarge = bodySizeGuard(req)
  if (tooLarge) return tooLarge
  const denied = authorize(req)
  if (denied) return denied

  let body: { version?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (body.version !== 'v1' && body.version !== 'v2') {
    return NextResponse.json({ error: "version must be 'v1' or 'v2'" }, { status: 400 })
  }

  const res = NextResponse.json({ ok: true, version: body.version })
  res.headers.set('Cache-Control', 'no-store')
  if (body.version === 'v1') {
    res.cookies.set({ ...COOKIE_BASE, value: '', maxAge: 0 })
    return res
  }
  const cookieSecret = process.env.UI_V2_COOKIE_SECRET
  if (!cookieSecret) {
    return NextResponse.json({ error: 'ui-version not configured' }, { status: 503 })
  }
  res.cookies.set({ ...COOKIE_BASE, value: signUiVersionCookie(cookieSecret), maxAge: UI_COOKIE_MAX_AGE_S })
  return res
}
