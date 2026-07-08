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
 */
export function trustedClientIp(req: Request): string {
  const vercelIp = req.headers.get('x-vercel-forwarded-for')
  if (vercelIp) {
    const first = firstToken(vercelIp)
    if (first) return first
  }

  const realIp = req.headers.get('x-real-ip')?.trim()
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
