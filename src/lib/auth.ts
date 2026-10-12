/**
 * Shared authentication helpers for API routes.
 *
 * [N-04] Extracted from tick, heartbeat/admin, and kill-switch routes
 * to eliminate duplication of the pre-hash + timingSafeEqual pattern.
 *
 * The Telegram webhook uses a different auth scheme (raw header comparison)
 * and is intentionally NOT included here.
 */

import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto'

/**
 * Per-process comparison key — drawn once at module load, held only in
 * memory, never persisted, logged or configured. It exists solely so both
 * sides of a comparison are reduced to fixed-length, unpredictable 32-byte
 * MACs before `timingSafeEqual`; nothing derived from it is stored, so a
 * fresh key on every cold start changes no behaviour.
 */
const COMPARISON_KEY = randomBytes(32)

/**
 * Constant-time Bearer token verification via HMAC-SHA256 pre-hash.
 *
 * MAC-ing both sides with the same in-process key produces fixed 32-byte
 * digests, which:
 *   1. Eliminates the length leak that direct timingSafeEqual would have
 *      on variable-length inputs (early return on different lengths).
 *   2. Makes the comparison constant-time regardless of input lengths.
 *
 * This is a comparator, not credential storage (CodeQL
 * js/insufficient-password-hash, alert #1): no digest leaves this function,
 * and `expectedSecret` is a machine-generated token (`openssl rand -hex 32`
 * per .env.example), so a work-factor hash (bcrypt/scrypt/argon2) would add
 * latency to every admin/monitor call with no security gain.
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
    const macA = createHmac('sha256', COMPARISON_KEY).update(token).digest()
    const macB = createHmac('sha256', COMPARISON_KEY).update(expectedSecret).digest()
    return timingSafeEqual(macA, macB)
  } catch {
    return false
  }
}
