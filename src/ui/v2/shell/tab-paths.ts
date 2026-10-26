/**
 * [ADR-025] The 8 app tabs of the v2 shell and their URL paths. PURE (no React, no next/headers): proxy.ts
 * imports it for the generic `/<tab>` → `/v2/<tab>` rule and the shell imports it for the tab strip.
 * Order and labels: pack round4/desktop/01 (Swap · Portfolio · DCA · Limit · SL/TP · Orders · History · Analytics).
 */
export const V2_TABS = [
  { id: 'swap', path: '/swap', label: 'Swap' },
  { id: 'portfolio', path: '/portfolio', label: 'Portfolio' },
  { id: 'dca', path: '/dca', label: 'DCA' },
  { id: 'limit', path: '/limit', label: 'Limit' },
  { id: 'sltp', path: '/sltp', label: 'SL/TP' },
  { id: 'orders', path: '/orders', label: 'Orders' },
  { id: 'history', path: '/history', label: 'History' },
  { id: 'analytics', path: '/analytics', label: 'Analytics' },
] as const

export type V2TabId = (typeof V2_TABS)[number]['id']

export const V2_TAB_PATHS: readonly string[] = V2_TABS.map((t) => t.path)

/** Active tab for a pathname, with or without the `/v2` prefix; anything else (`/`, `/v2`) is Swap. */
export function tabIdFromPathname(pathname: string | null | undefined): V2TabId {
  const path = (pathname ?? '').replace(/^\/v2(?=\/|$)/, '').replace(/\/+$/, '') || '/'
  return V2_TABS.find((t) => t.path === path)?.id ?? 'swap'
}
