/**
 * The ONE gate for an EVM address that came from outside (query string, body). Accepts exactly
 * `0x` + 40 hex chars and returns the lowercase form; anything else is null. No trimming, no
 * decoding, no checksum interpretation — a value that is not already that shape is junk.
 * Used at the route boundary and again before any price-source URL is built (request-forgery guard).
 */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) return null
  return value.toLowerCase()
}
