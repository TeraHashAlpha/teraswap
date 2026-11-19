/**
 * [A87b R2-1] The browser's one way to call GET /api/orders/:id/executions.
 *
 * The route needs the wallet's read signature for a LIVE order (orders/[id]/executions/route.ts) and ignores it for a
 * finished one. So every caller goes through here: it sends the read-signature headers the Orders tab already holds
 * (ordersReadHeaders — cached for the session, nothing new is signed for them), and on a 401 takes the SAME
 * sign-once-and-retry path the order list uses (ensureOrdersReadAuth: one prompt however many panels ask, a refusal
 * remembered for the session), then retries ONCE. With nothing cached and no signer the 401 is handed back as it came,
 * so the caller shows no fills rather than inventing any.
 *
 * [A97 S-1] `wallet` is the order's OWNER (the URL names it). A signer is used only when that wallet is the account the
 * Orders tab has connected (getOrdersReadSigner(wallet)): an order kept on screen after an account switch never makes the
 * new account sign a message naming the old one; its fills call just gets the server's 401 (no prompt, nothing cached, no
 * refusal recorded). ensureOrdersReadAuth stores only a signature that recovers to `wallet`.
 *
 * [A97 S-8] `live`: the caller's order is live (active, executing, partially filled). With its owner connected, the read
 * signature is made sure of BEFORE the first request (signing once if nothing valid is cached), so the first request
 * already carries it instead of logging a 401 first. A finished order (receipts, history) is never signed for here.
 *
 * With no cached signature and no live order the request is the exact single-argument `fetch(url)` it was before this
 * file existed.
 */
import { ensureOrdersReadAuth, getOrdersReadSigner, ordersReadHeaders } from './read-auth'

/** [A97 S-8] An order the server still holds as live (its fills need the read signature). 'signing' is not on the server yet. */
export function isLiveOrderStatus(status: string): boolean {
  return status === 'active' || status === 'executing' || status === 'partially_filled'
}

export function orderExecutionsUrl(orderId: string, wallet: string): string {
  return `/api/orders/${orderId}/executions?wallet=${wallet}`
}

export async function fetchOrderExecutions(
  orderId: string,
  wallet: string,
  opts: { live?: boolean } = {},
): Promise<Response> {
  const url = orderExecutionsUrl(orderId, wallet)
  const get = () => {
    const headers = ordersReadHeaders(wallet)
    return headers ? fetch(url, { headers }) : fetch(url)
  }
  const signer = getOrdersReadSigner(wallet)
  if (opts.live && signer) await ensureOrdersReadAuth(wallet, signer)
  const res = await get()
  if (res.status !== 401 || !signer) return res
  const outcome = await ensureOrdersReadAuth(wallet, signer)
  if (outcome !== 'ok') return res
  return get()
}
