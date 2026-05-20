// CORS origin allow-list — used by public logging endpoints (EXT-L-01).
// Browsers enforce CORS; we default to the production origin for non-allowed
// requesters rather than returning 403, so server-to-server callers still work.

const ALLOWED_ORIGINS = [
  'https://teraswap.app',
  'https://www.teraswap.app',
]

/** Returns CORS origin header value, or null if origin not allowed */
export function getAllowedOrigin(request: Request): string | null {
  const origin = request.headers.get('origin')
  if (!origin) return null

  // Allow exact matches
  if (ALLOWED_ORIGINS.includes(origin)) return origin

  // Allow Vercel preview deploys
  if (origin.endsWith('.vercel.app')) return origin

  // Allow localhost for development
  if (origin.startsWith('http://localhost:')) return origin

  return null
}
