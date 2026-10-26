/**
 * [ADR-025] UI-version cookie + resolution rule — PURE (node:crypto only), so proxy.ts, the admin route and
 * getUiVersion() share one implementation. `v2` iff UI_V2_ENABLED === 'true' (never NEXT_PUBLIC_) or the
 * `ts_ui` cookie carries hex(HMAC-SHA256('v2')) under UI_V2_COOKIE_SECRET. Everything else is `v1`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export type UiVersion = 'v1' | 'v2'

export const UI_COOKIE_NAME = 'ts_ui'
export const UI_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

const SIGNED_VALUE = 'v2'
const HEX_SHA256 = /^[0-9a-f]{64}$/

/** hex(HMAC-SHA256('v2')) under `secret` — the only cookie value that selects v2. */
export function signUiVersionCookie(secret: string): string {
  return createHmac('sha256', secret).update(SIGNED_VALUE).digest('hex')
}

/** Constant-time check. A missing secret or malformed value is always false (fail closed to v1). */
export function isValidUiCookie(value: string | undefined, secret: string | undefined): boolean {
  if (!secret || !value || !HEX_SHA256.test(value)) return false
  const expected = createHmac('sha256', secret).update(SIGNED_VALUE).digest()
  const given = Buffer.from(value, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export interface UiVersionInputs {
  /** process.env.UI_V2_ENABLED */
  enabled?: string
  /** process.env.UI_V2_COOKIE_SECRET — unset disables the cookie path */
  secret?: string
  /** value of the `ts_ui` cookie */
  cookie?: string
}

export function resolveUiVersion({ enabled, secret, cookie }: UiVersionInputs): UiVersion {
  if (enabled === 'true') return 'v2'
  return isValidUiCookie(cookie, secret) ? 'v2' : 'v1'
}
