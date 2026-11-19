/**
 * [A97 S-7] The orders reads (GET /api/orders, /api/orders/:id, /api/orders/:id/executions) answer one wallet, and for a
 * live order only with that wallet's read signature (headers, not the URL): no browser or shared cache may keep or reuse
 * an answer. Every response of those three handlers carries this, the 4xx ones included.
 */
export const ORDERS_READ_CACHE_CONTROL = 'private, no-store'

export function withOrdersReadCacheControl<T extends Response>(res: T): T {
  res.headers.set('Cache-Control', ORDERS_READ_CACHE_CONTROL)
  return res
}
