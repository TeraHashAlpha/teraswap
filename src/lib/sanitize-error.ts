/**
 * [SPRINT-9J J2] Redact secrets from an error message before returning it to the
 * client (e.g. /api/swap's `{ error }` body). An upstream adapter error can
 * embed a request URL with an `?apiKey=…`, an `Authorization: Bearer …` header,
 * or a `key=…` assignment. Strip those while keeping the readable failure reason.
 */
export function sanitizeUpstreamError(message: unknown): string {
  let s =
    typeof message === 'string'
      ? message
      : message instanceof Error
        ? message.message
        : String(message ?? '')

  // 1. URL query strings may carry an API key → drop the whole query.
  s = s.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, '$1?[redacted]')
  // 2. Bearer tokens (run before the generic assignment rule below).
  s = s.replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  // 3. key / secret / token / password / authorization assignments.
  s = s.replace(
    /\b(api[-_]?key|key|secret|token|password|authorization)\b\s*[:=]\s*[^\s,&)"']+/gi,
    '$1=[redacted]',
  )
  return s
}
