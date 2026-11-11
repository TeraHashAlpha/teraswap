import type { NextRequest } from 'next/server'
import { bodySizeGuard } from '@/lib/body-limit'
import {
  COW_PROXY_MAX_BODY_BYTES,
  cowBadRequest,
  cowInternalError,
  cowJson,
  cowRateLimitGate,
  pickCancellation,
  pickSignedOrder,
  readRequestJson,
  relayToCow,
  resolveCowChainId,
} from '@/lib/cow-proxy'

/**
 * /api/cow/orders?chainId=<1|8453|42161> — a signed CoW order, submitted to CoW's orderbook by our server.
 * [fix/user-ip-privacy A76 S-1]
 *
 * POST: the signed order (adapters/cow.ts submitCowOrder after the wallet signed it; limit-order-api.ts
 *   submitLimitOrder). Only the GPv2 order fields + signature are forwarded (cow-proxy.ts pickSignedOrder).
 *   → CoW's answer: the order uid (a JSON string), or CoW's errorType/description with CoW's 4xx status.
 * DELETE ?uid=<order uid>: a signed cancellation of that one order (limit-order-api.ts cancelLimitOrder).
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const tooLarge = bodySizeGuard(req, COW_PROXY_MAX_BODY_BYTES)
    if (tooLarge) return tooLarge
    const limited = await cowRateLimitGate(req, 'orders')
    if (limited) return limited
    const chainId = resolveCowChainId(req.nextUrl.searchParams.get('chainId'))
    if (chainId === null) return cowBadRequest('chainId')
    const picked = pickSignedOrder(await readRequestJson(req))
    if (!picked.ok) return cowBadRequest(picked.error)
    return cowJson(await relayToCow({ chainId, method: 'POST', path: '/orders', body: picked.value }))
  } catch {
    return cowInternalError()
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const tooLarge = bodySizeGuard(req, COW_PROXY_MAX_BODY_BYTES)
    if (tooLarge) return tooLarge
    const limited = await cowRateLimitGate(req, 'orders')
    if (limited) return limited
    const chainId = resolveCowChainId(req.nextUrl.searchParams.get('chainId'))
    if (chainId === null) return cowBadRequest('chainId')
    const picked = pickCancellation(req.nextUrl.searchParams.get('uid'), await readRequestJson(req))
    if (!picked.ok) return cowBadRequest(picked.error)
    return cowJson(await relayToCow({ chainId, method: 'DELETE', path: `/orders/${picked.value.uid}`, body: picked.value.body }))
  } catch {
    return cowInternalError()
  }
}
