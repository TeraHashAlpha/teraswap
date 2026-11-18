/**
 * [A87b R2-1] The browser's one way to call GET /api/orders/:id/executions.
 *
 * The route needs the wallet's read signature for a LIVE order (orders/[id]/executions/route.ts) and ignores it for a
 * finished one. So every caller goes through here: it sends the read-signature headers the Orders tab already holds
 * (ordersReadHeaders — cached for the session, nothing new is signed for them), and on a 401 takes the SAME
 * sign-once-and-retry path the order list uses (ensureOrdersReadAuth: one prompt however many panels ask, a refusal
 * remembered for the session), then retries ONCE. With nothing cached and no signer (no Orders surface mounted) the 401
 * is handed back as it came, so the caller shows no fills rather than inventing any.
 *
 * With no cached signature the request is the exact single-argument `fetch(url)` it was before this file existed.
 */
import { ensureOrdersReadAuth, getOrdersReadSigner, ordersReadHeaders } from './read-auth'

export function orderExecutionsUrl(orderId: string, wallet: string): string {
  return `/api/orders/${orderId}/executions?wallet=${wallet}`
}

export async function fetchOrderExecutions(orderId: string, wallet: string): Promise<Response> {
  const url = orderExecutionsUrl(orderId, wallet)
  const get = () => {
    const headers = ordersReadHeaders(wallet)
    return headers ? fetch(url, { headers }) : fetch(url)
  }
  const res = await get()
  if (res.status !== 401) return res
  const signer = getOrdersReadSigner()
  if (!signer) return res
  const outcome = await ensureOrdersReadAuth(wallet, signer)
  if (outcome !== 'ok') return res
  return get()
}
