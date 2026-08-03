/**
 * [CHORE-API-HARDENING-2 / P3a CONFIRMED] Trusted client-IP extraction for
 * rate-limiting keys.
 *
 * Every per-IP limiter in this repo took the LEFT-MOST `X-Forwarded-For` token
 * (`req.headers.get('x-forwarded-for')?.split(',')[0]`). On Vercel, a client can
 * prepend arbitrary entries to `x-forwarded-for` — the platform APPENDS the true
 * connecting IP as the LAST entry — so trusting the first token trusts exactly
 * the attacker-controlled end. This let anyone (a) bypass every per-IP rate
 * limit by sending a fresh random left-most token per request, (b) exhaust a
 * victim's bucket by setting the left-most token to the victim's real IP, and
 * (c) spray arbitrary strings into the Redis rate-limit key
 * (`ratelimit:quote:<attacker-string>`).
 *
 * Fix: prefer `x-vercel-forwarded-for` — set by Vercel's edge network with the
 * real connecting client IP; the platform strips any client-supplied value of
 * the same name before the request reaches the function, so it cannot be
 * spoofed. Fall back to `x-real-ip` (also platform-set) for non-Vercel/local
 * environments, then to the RIGHT-most `x-forwarded-for` entry (the hop nearest
 * the trusted proxy) as a last resort, then `'unknown'`.
 *
 * ── [FIX-CLIENT-IP-CLOUDFLARE-AWARE] ────────────────────────────────────────
 * teraswap.app is now proxied through Cloudflare, so the peer that connects to
 * Vercel is a CF EDGE. `x-vercel-forwarded-for` therefore reports that edge, and
 * every per-IP limiter (rpc / quote / swap / log, via kv-rate-limiter) bucketed
 * by edge instead of by client: thousands of unrelated users behind one edge
 * shared a single bucket, while a real abuser behind CF was invisible inside it.
 *
 * `CF-Connecting-IP` carries the real client — but it is only believable when
 * the request actually came through Cloudflare. CF OVERWRITES that header at its
 * edge (a client-supplied value never survives), whereas anyone reaching the
 * Vercel origin directly can set it to anything. So it is trusted behind a gate:
 *
 *     peer ∈ Cloudflare's published ranges  AND  CF-Connecting-IP parses as an IP
 *
 * BOTH must hold. Fail either and we fall through to the exact pre-existing
 * chain below — so a direct-to-origin attacker cannot nominate their own client
 * IP (they get their real one), and a malformed header never reaches a Redis
 * key. With no Cloudflare in front, behaviour is byte-identical to before.
 */
import { isCloudflareIp, isValidIp } from './cloudflare-ips'

export function trustedClientIp(req: Request): string {
  // The platform-set headers, read exactly as the pre-Cloudflare chain read them.
  const vercelIp = req.headers.get('x-vercel-forwarded-for')
  const vercelFirst = vercelIp ? firstToken(vercelIp) : ''
  const realIp = req.headers.get('x-real-ip')?.trim() ?? ''

  // [FIX-CLIENT-IP-CLOUDFLARE-AWARE] The peer that actually opened the connection
  // to Vercel — platform-set headers ONLY, never `x-forwarded-for`, which the
  // client can write to. If that peer is a Cloudflare edge then the request came
  // through CF, and `CF-Connecting-IP` is CF's own unspoofable statement of who
  // the client is.
  const peer = vercelFirst || realIp
  if (peer && isCloudflareIp(peer)) {
    const cfIp = req.headers.get('cf-connecting-ip')?.trim()
    // Validate BEFORE returning: this value becomes part of
    // `ratelimit:<route>:<ip>`, and an unvalidated header is the P3a
    // key-poisoning hole all over again.
    if (cfIp && isValidIp(cfIp)) return cfIp
    // Absent, or present-but-garbage: fall through. Bucketing by the CF edge is
    // degraded but safe — we never trust a value we could not parse.
  }

  // ── Unchanged below this line ──
  if (vercelFirst) return vercelFirst

  if (realIp) return realIp

  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1] // right-most: nearest trusted hop
  }

  return 'unknown'
}

function firstToken(headerValue: string): string {
  return headerValue.split(',')[0]?.trim() || ''
}
