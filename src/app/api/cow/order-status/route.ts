import type { NextRequest } from 'next/server'
import { cowBadRequest, cowInternalError, cowJson, cowRateLimitGate, ORDER_UID_RE, relayToCow, resolveCowChainId } from '@/lib/cow-proxy'

/**
 * GET /api/cow/order-status?chainId=<1|8453|42161>&uid=<order uid> — CoW's record of one order (status, executed
 * amounts), read by our server. Polled by adapters/cow.ts pollCowOrderStatus after a CoW swap is submitted and by
 * limit-order-api.ts fetchLimitOrderStatus. Only the checked uid reaches CoW. [fix/user-ip-privacy A76 S-1]
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const limited = await cowRateLimitGate(req, 'order-status')
    if (limited) return limited
    const chainId = resolveCowChainId(req.nextUrl.searchParams.get('chainId'))
    if (chainId === null) return cowBadRequest('chainId')
    const uid = req.nextUrl.searchParams.get('uid')
    if (uid === null || !ORDER_UID_RE.test(uid)) return cowBadRequest('uid')
    return cowJson(await relayToCow({ chainId, method: 'GET', path: `/orders/${uid}` }))
  } catch {
    return cowInternalError()
  }
}
