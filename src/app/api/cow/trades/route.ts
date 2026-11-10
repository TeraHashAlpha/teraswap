import type { NextRequest } from 'next/server'
import { cowBadRequest, cowInternalError, cowJson, cowRateLimitGate, ORDER_UID_RE, relayToCow, resolveCowChainId } from '@/lib/cow-proxy'

/**
 * GET /api/cow/trades?chainId=<1|8453|42161>&orderUid=<order uid> — the settlement(s) of one CoW order (tx hash,
 * executed amounts), read by our server once the order is filled. Only the checked uid reaches CoW.
 * [fix/user-ip-privacy A76 S-1]
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const limited = await cowRateLimitGate(req, 'trades')
    if (limited) return limited
    const chainId = resolveCowChainId(req.nextUrl.searchParams.get('chainId'))
    if (chainId === null) return cowBadRequest('chainId')
    const orderUid = req.nextUrl.searchParams.get('orderUid')
    if (orderUid === null || !ORDER_UID_RE.test(orderUid)) return cowBadRequest('orderUid')
    return cowJson(await relayToCow({ chainId, method: 'GET', path: `/trades?orderUid=${orderUid}` }))
  } catch {
    return cowInternalError()
  }
}
