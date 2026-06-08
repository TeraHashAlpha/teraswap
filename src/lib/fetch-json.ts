/**
 * [SPRINT-9X X3] Safe JSON fetch for OUR OWN /api/* endpoints (defense-in-depth for the quote-path
 * "<!DOCTYPE is not valid JSON" class — INC-2026-05-31-001 / SPRINT-9X).
 *
 * Even with the server bounded (9J/J2 + 9X maxDuration), a transient platform/proxy hiccup can return
 * an HTML error page (Vercel 502/504, gateway timeout) where the app expects JSON. A raw
 * `await res.json()` then throws `Unexpected token '<', "<!DOCTYPE"... is not valid JSON` — an ugly,
 * confusing string the UI must never surface. `fetchJson` detects a non-JSON/HTML body and instead
 * throws a CLEAN, typed `ServiceUnavailableError`, retrying ONCE (these platform errors are usually
 * transient) before giving up. Real JSON error envelopes (429/4xx/5xx with a JSON body) pass through
 * untouched so callers keep their existing status-based handling.
 */

/** Typed error for a non-JSON / HTML response from one of our APIs. Carries the HTTP status. */
export class ServiceUnavailableError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ServiceUnavailableError'
    this.status = status
  }
}

const RETRY_DELAY_MS = 400

function looksLikeHtmlOrNonJson(body: string, contentType: string | null): boolean {
  const trimmed = body.trimStart()
  if (trimmed.length === 0) return true // empty body — not JSON
  if (trimmed.startsWith('<')) return true // HTML / XML platform error page
  if (contentType && contentType.includes('text/html')) return true
  return false
}

/**
 * Fetch `input` and parse JSON safely. Returns `{ res, data }` so callers can still branch on
 * `res.ok` / status for their own JSON error envelopes. Throws `ServiceUnavailableError` (clean
 * message, never a raw parse string) when the body is HTML/non-JSON, after one transparent retry.
 * An AbortError (superseded request) propagates unchanged — it is NOT retried.
 */
export async function fetchJson<T = unknown>(
  input: string,
  init?: RequestInit,
  opts: { retries?: number } = {},
): Promise<{ res: Response; data: T }> {
  const retries = opts.retries ?? 1
  let lastErr: ServiceUnavailableError | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(input, init) // AbortError throws here and propagates (superseded request)
    const body = await res.text()

    if (looksLikeHtmlOrNonJson(body, res.headers.get('content-type'))) {
      lastErr = new ServiceUnavailableError('Service busy — please retry in a moment.', res.status || 503)
      if (attempt < retries) { await new Promise(r => setTimeout(r, RETRY_DELAY_MS)); continue }
      throw lastErr
    }

    try {
      return { res, data: JSON.parse(body) as T }
    } catch {
      // Content-type lied or body was truncated → treat as a platform glitch, not a parse crash.
      lastErr = new ServiceUnavailableError('Service busy — please retry in a moment.', res.status || 503)
      if (attempt < retries) { await new Promise(r => setTimeout(r, RETRY_DELAY_MS)); continue }
      throw lastErr
    }
  }

  // Unreachable (the loop always returns or throws), but satisfies the type checker.
  throw lastErr ?? new ServiceUnavailableError('Service busy — please retry in a moment.', 503)
}
