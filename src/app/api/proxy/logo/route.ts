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
 *
 * Not an open proxy: the upstream URL is a FIXED template. Only the chain folder (from a Map) and
 * the address (validated, then re-checksummed by viem) vary, so a caller cannot steer the fetch
 * anywhere but a Trust Wallet `logo.png`.
 *
 * @internal — server-only route. Reads only; no auth, no fund flow, no state write.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'

/** chainId → Trust Wallet `blockchains/<folder>`. A Map so no key can reach a prototype property. */
const TRUST_WALLET_CHAIN = new Map<number, string>([
  [1, 'ethereum'],
  [8453, 'base'],
  [42161, 'arbitrum'],
])

/** Raster only: an SVG served from our origin could carry script if opened directly. */
const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Trust Wallet logos are ~5–30 KB; anything far beyond that is not a logo. */
const MAX_LOGO_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 5_000

const LOGO_CACHE_CONTROL = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800'
// A miss is cached for an hour at the edge, so a token without a logo is not re-fetched per view.
const MISS_CACHE_CONTROL = 'public, s-maxage=3600'

/** Digits-only first (no `__proto__`-style keys), then the Map lookup. */
function trustWalletFolder(raw: string | null): string | null {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null
  return TRUST_WALLET_CHAIN.get(Number(raw)) ?? null
}

function trustWalletLogoUrl(folder: string, address: string): string {
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/assets/${address}/logo.png`
}

function miss(): NextResponse {
  return new NextResponse(null, { status: 404, headers: { 'Cache-Control': MISS_CACHE_CONTROL } })
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const folder = trustWalletFolder(req.nextUrl.searchParams.get('chainId'))
  const rawAddress = req.nextUrl.searchParams.get('address') ?? ''
  if (!folder || !isAddress(rawAddress, { strict: false })) {
    return NextResponse.json({ error: 'Invalid chainId or address' }, { status: 400 })
  }
  // Trust Wallet folders are keyed by the EIP-55 checksum; lowercasing first means a
  // mis-checksummed input is normalised instead of throwing.
  const address = getAddress(rawAddress.toLowerCase())

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const upstream = await fetch(trustWalletLogoUrl(folder, address), {
      signal: controller.signal,
      redirect: 'error',
    })
    if (!upstream.ok) return miss()

    const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) return miss()
    if (Number(upstream.headers.get('content-length') ?? 0) > MAX_LOGO_BYTES) return miss()

    const body = await upstream.arrayBuffer()
    if (body.byteLength > MAX_LOGO_BYTES) return miss()

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': LOGO_CACHE_CONTROL,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  } catch {
    return miss()
  } finally {
    clearTimeout(timeout)
  }
}
