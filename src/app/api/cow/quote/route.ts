import type { NextRequest } from 'next/server'
import { bodySizeGuard } from '@/lib/body-limit'
import {
  buildPriceQuoteBody,
  COW_PROXY_MAX_BODY_BYTES,
  cowBadRequest,
  cowInternalError,
  cowJson,
  cowRateLimitGate,
  pickPriceQuoteParams,
  readRequestJson,
  relayToCow,
  resolveCowChainId,
} from '@/lib/cow-proxy'

/**
 * POST /api/cow/quote?chainId=<1|8453|42161> — a CoW price quote for a pair, made by our server.
 *
 * Body: `{ sellToken, buyToken, sellAmountBeforeFee }` (nothing else is read). The upstream /quote body is built
 * server-side (cow-proxy.ts buildPriceQuoteBody). Used by the limit-order panel's market price
 * (limit-order-api.ts fetchCurrentPrice), which used to call api.cow.fi from the browser. [fix/user-ip-privacy A76 S-1]
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const tooLarge = bodySizeGuard(req, COW_PROXY_MAX_BODY_BYTES)
    if (tooLarge) return tooLarge
    const limited = await cowRateLimitGate(req, 'quote')
    if (limited) return limited
    const chainId = resolveCowChainId(req.nextUrl.searchParams.get('chainId'))
    if (chainId === null) return cowBadRequest('chainId')
    const picked = pickPriceQuoteParams(await readRequestJson(req))
    if (!picked.ok) return cowBadRequest(picked.error)
    return cowJson(await relayToCow({ chainId, method: 'POST', path: '/quote', body: buildPriceQuoteBody(picked.value) }))
  } catch {
    return cowInternalError()
  }
}
