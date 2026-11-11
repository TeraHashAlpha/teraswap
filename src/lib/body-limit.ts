/**
 * [AUDIT-W6 / W6-L-01] Shared request body-size guard.
 *
 * Extracted from the swap route's content-length cap so every body route can
 * refuse oversized payloads app-side (413 JSON) instead of relying on the
 * platform default (~4 MB). Header-only check — cheap, runs before any body
 * read; an absent/malformed content-length passes (JSON parsing and field
 * validation still bound what a request can do downstream).
 */
import { NextResponse } from 'next/server'
import { clientIpKey } from './client-ip-key'

/** Default cap for JSON API bodies — matches the swap route's 10 KB. */
export const DEFAULT_MAX_BODY_BYTES = 10_000

/** The RPC proxy forwards eth_call simulations whose calldata can be large
 *  (the app itself allows up to ~200 KB of swap calldata) — cap generously
 *  but finitely. */
export const RPC_MAX_BODY_BYTES = 262_144 // 256 KB

/** Per-client bucket name shared by rate-limit call sites.
 *  [CHORE-API-HARDENING-2 / P3a] Derived from trustedClientIp — the left-most
 *  x-forwarded-for token is attacker-controlled on Vercel; see trusted-ip.ts.
 *  [fix/user-ip-privacy] Returns the KEYED HASH of that IP (client-ip-key.ts), never the address:
 *  every caller only builds a rate-limit key from it, and the raw IP used to end up in Upstash and,
 *  on a Redis outage, in the function logs. The name is kept so the call sites do not change. */
export function clientIp(req: Request): string {
  return clientIpKey(req)
}

/**
 * Returns a 413 JSON response when the declared content-length exceeds
 * `maxBytes`, else null (proceed). Pass `headers` to keep CORS on the
 * refusal for browser-facing telemetry routes.
 */
export function bodySizeGuard(
  req: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
  headers?: Record<string, string>,
): NextResponse | null {
  const declared = Number.parseInt(req.headers.get('content-length') || '', 10)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return NextResponse.json(
      { error: 'Request body too large' },
      { status: 413, headers },
    )
  }
  return null
}
