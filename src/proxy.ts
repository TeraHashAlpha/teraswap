import { NextResponse, type NextRequest } from 'next/server'
import { isV2EnableEnabled, isV2KitEnabled } from '@/ui/v2/kit-gate'
import { V2_TAB_PATHS } from '@/ui/v2/shell/tab-paths'
import { UI_COOKIE_NAME, resolveUiVersion } from '@/ui/v2/ui-cookie'

/**
 * [ADR-025] The UI switch. Measured: any in-page switch (next/dynamic or conditional import) puts the v2
 * client modules in the SAME chunk set as v1 (Turbopack bundles a page's whole client graph), so v2 would
 * ship to v1 visitors. v2 therefore lives on its own route (/v2) and is reached by rewriting here.
 *   `/`      v2 → rewrite to /v2 (URL unchanged; the Swap tab, or the landing before the app is launched); v1 → untouched (static v1 page, byte-identical)
 *   `/<tab>` the 8 app tabs (`V2_TAB_PATHS`): ONE generic rule — v2 → rewrite to `/v2/<tab>` (URL unchanged); v1 → untouched
 *            (`/swap` and `/analytics` are v1 pages today and stay exactly as they are for v1 visitors)
 *   `/v2/*`  only when the switch says v2; otherwise a REAL 404 (rewrite to a path that does not exist)
 *   `/v2/_kit` the dev kit: Preview/`next dev` only, independent of the switch (a prod owner cookie does not open it)
 *   `/v2/_enable` the preview opt-in form (POSTs the admin secret, sets the signed cookie): same gate as the kit — it must
 *            be reachable BEFORE the cookie exists, so it cannot depend on the switch
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
  if (V2_TAB_PATHS.includes(req.nextUrl.pathname)) {
    return v2 ? NextResponse.rewrite(new URL(`/v2${req.nextUrl.pathname}`, req.url)) : NextResponse.next()
  }
  const path = req.nextUrl.pathname
  const allowed = path === '/v2/_kit' ? isV2KitEnabled() : path === '/v2/_enable' ? isV2EnableEnabled() : v2
  return allowed ? NextResponse.next() : NextResponse.rewrite(new URL(NOT_FOUND_PATH, req.url))
}

// Next statically parses `config`: the matcher must be literals (no spread). proxy.test.ts pins the tab entries to V2_TAB_PATHS.
export const config = {
  matcher: ['/', '/swap', '/portfolio', '/dca', '/limit', '/sltp', '/orders', '/history', '/analytics', '/v2', '/v2/:path*'],
}
