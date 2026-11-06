/**
 * [fix/user-ip-privacy A76 S-1] The same-origin CoW Protocol endpoints the BROWSER calls. Our server relays each one
 * to CoW (cow-proxy.ts), so CoW sees our server's IP address, never the visitor's — and the site's CSP, whose
 * `connect-src` has no CoW host, keeps it that way.
 *
 * Isomorphic and dependency-free: imported by client code (adapters/cow.ts submit + poll, limit-order-api.ts).
 */
export const COW_PROXY_PATHS = {
  quote: '/api/cow/quote',
  orders: '/api/cow/orders',
  orderStatus: '/api/cow/order-status',
  trades: '/api/cow/trades',
} as const

/** `<path>?chainId=<id>[&<k>=<v>…]` — relative, same origin. */
export function cowProxyUrl(path: (typeof COW_PROXY_PATHS)[keyof typeof COW_PROXY_PATHS], chainId: number, params: Record<string, string> = {}): string {
  return `${path}?${new URLSearchParams({ chainId: String(chainId), ...params }).toString()}`
}
