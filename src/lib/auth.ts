/**
 * Shared authentication helpers for API routes.
 *
 * [N-04] Extracted from tick, heartbeat/admin, and kill-switch routes
 * to eliminate duplication of the SHA-256 + timingSafeEqual pattern.
 *
 * The Telegram webhook uses a different auth scheme (raw header comparison)
 * and is intentionally NOT included here.
 */

import { timingSafeEqual, createHash } from 'node:crypto'

/**
 * Constant-time Bearer token verification via SHA-256 pre-hash.
 *
 * Hashing both sides produces fixed 32-byte digests, which:
 *   1. Eliminates the length leak that direct timingSafeEqual would have
 *      on variable-length inputs (early return on different lengths).
 *   2. Makes the comparison constant-time regardless of input lengths.
 *
 * @param authHeader  The raw Authorization header value (e.g., "Bearer abc123")
 * @param expectedSecret  The expected secret (from env var)
 * @returns true if the Bearer token matches the expected secret
 */
export function verifyBearerToken(authHeader: string | null, expectedSecret: string): boolean {
  if (!authHeader || !expectedSecret) return false
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return false
  try {
    const hashA = createHash('sha256').update(token).digest()
    const hashB = createHash('sha256').update(expectedSecret).digest()
    return timingSafeEqual(hashA, hashB)
  } catch {
    return false
  }
}
