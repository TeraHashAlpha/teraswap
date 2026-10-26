/**
 * [ADR-025] `getUiVersion()` for server components/routes (reads the request cookie via next/headers, so it
 * cannot be bundled into a client component). proxy.ts uses the same `resolveUiVersion` rule on the request.
 */
import { cookies } from 'next/headers'
import { UI_COOKIE_NAME, resolveUiVersion, type UiVersion } from './ui-cookie'

export type { UiVersion }

export async function getUiVersion(): Promise<UiVersion> {
  const enabled = process.env.UI_V2_ENABLED
  const secret = process.env.UI_V2_COOKIE_SECRET
  // Env flag on, or no secret (cookie path disabled): decided without touching the request cookies.
  if (enabled === 'true' || !secret) return resolveUiVersion({ enabled, secret })
  const jar = await cookies()
  return resolveUiVersion({ enabled, secret, cookie: jar.get(UI_COOKIE_NAME)?.value })
}
