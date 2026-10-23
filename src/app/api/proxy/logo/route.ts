/**
 * /api/proxy/logo — Trust Wallet token logo, fetched SERVER-SIDE and streamed back.
 *
 * [fix/functional-chain-ui C8] <TokenLogo>'s Trust Wallet candidate used to be a browser-direct
 * `https://raw.githubusercontent.com/trustwallet/assets/…` <img>, which leaked every visitor's IP
 * to GitHub and kept that host in CSP img-src. The browser now only ever talks to this route.
 *
 *   GET /api/proxy/logo?chainId=<1|8453|42161>&address=<0x..40hex>
 *     → 200 the image bytes (raster image/* only), cached 24 h
 *     → 400 a chainId without a Trust Wallet folder, or a malformed address
 *     → 404 upstream miss / timeout / non-image / oversized body — a missing logo is cosmetic,
 *           <TokenLogo> advances to its generated avatar on any error status
 *     → 429 past the per-IP limit (QUOTE_RATE_LIMIT, no-store)
 *
 * Not an open proxy: the upstream URL is a FIXED template. Only the chain folder (from a Map) and
 * the address (validated, then re-checksummed by viem) vary, so a caller cannot steer the fetch
 * anywhere but a Trust Wallet `logo.png`. The fetch itself (host allow-list, raster-only, size and
 * time caps) lives in `@/lib/logo-proxy`, shared with /api/token-logo.
 *
 * @internal — server-only route. Reads only; no auth, no fund flow, no state write.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { checkRateLimit, QUOTE_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { trustedClientIp } from '@/lib/trusted-ip'
import { fetchLogo, logoMiss, logoResponse } from '@/lib/logo-proxy'

/** chainId → Trust Wallet `blockchains/<folder>`. A Map so no key can reach a prototype property. */
const TRUST_WALLET_CHAIN = new Map<number, string>([
  [1, 'ethereum'],
  [8453, 'base'],
  [42161, 'arbitrum'],
])

/** Digits-only first (no `__proto__`-style keys), then the Map lookup. */
function trustWalletFolder(raw: string | null): string | null {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null
  return TRUST_WALLET_CHAIN.get(Number(raw)) ?? null
}

function trustWalletLogoUrl(folder: string, address: string): string {
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/assets/${address}/logo.png`
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Same limiter, limit and 429 shape as GET /api/quote (src/app/api/quote/route.ts:104-118). Edge-cached
  // logos never reach this function, so only misses count; the 429 is no-store so a throttled
  // request is never pinned in the CDN or the browser cache in place of the logo.
  const rateCheck = await checkRateLimit(
    `logo:${trustedClientIp(req)}`,
    QUOTE_RATE_LIMIT.limit,
    QUOTE_RATE_LIMIT.windowMs,
  )
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in a minute.' },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetAt),
        },
      },
    )
  }

  const folder = trustWalletFolder(req.nextUrl.searchParams.get('chainId'))
  const rawAddress = req.nextUrl.searchParams.get('address') ?? ''
  if (!folder || !isAddress(rawAddress, { strict: false })) {
    return NextResponse.json({ error: 'Invalid chainId or address' }, { status: 400 })
  }
  // Trust Wallet folders are keyed by the EIP-55 checksum; lowercasing first means a
  // mis-checksummed input is normalised instead of throwing.
  const address = getAddress(rawAddress.toLowerCase())

  const logo = await fetchLogo(trustWalletLogoUrl(folder, address))
  return logo ? logoResponse(logo) : logoMiss()
}
