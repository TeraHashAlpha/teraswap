import { NextResponse, type NextRequest } from 'next/server'
import { UI_COOKIE_NAME, resolveUiVersion } from '@/ui/v2/ui-cookie'

/**
 * [ADR-025] The UI switch. Measured: any in-page switch (next/dynamic or conditional import) puts the v2
 * client modules in the SAME chunk set as v1 (Turbopack bundles a page's whole client graph), so v2 would
 * ship to v1 visitors. v2 therefore lives on its own route (/v2) and is reached by rewriting here.
 *   `/`      v2 → rewrite to /v2 (URL unchanged); v1 → untouched (static v1 page, byte-identical)
 *   `/v2/*`  only when the switch says v2; otherwise a REAL 404 (rewrite to a path that does not exist)
 */
const NOT_FOUND_PATH = '/v2-disabled'

function uiVersion(req: NextRequest) {
  return resolveUiVersion({
    enabled: process.env.UI_V2_ENABLED,
    secret: process.env.UI_V2_COOKIE_SECRET,
    cookie: req.cookies.get(UI_COOKIE_NAME)?.value,
  })
}

export function proxy(req: NextRequest) {
  const v2 = uiVersion(req) === 'v2'
  if (req.nextUrl.pathname === '/') {
    return v2 ? NextResponse.rewrite(new URL('/v2', req.url)) : NextResponse.next()
  }
  return v2 ? NextResponse.next() : NextResponse.rewrite(new URL(NOT_FOUND_PATH, req.url))
}

export const config = { matcher: ['/', '/v2', '/v2/:path*'] }
