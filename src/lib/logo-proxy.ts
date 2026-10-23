/**
 * Server-side logo fetch-and-stream, shared by /api/proxy/logo and /api/token-logo.
 *
 * [fix/functional-chain-ui C8] The browser must never contact a third-party image host (it would
 * hand the visitor's IP to GitHub, CoinGecko or DefiLlama). Both routes resolve a logo URL on the
 * server and stream the bytes back from our own origin; this module is the one place that decides
 * what such a fetch may touch and what may be served.
 *
 *   • host allow-list  — https only, exact hostname, default port, no credentials. A URL that
 *                        arrives from an upstream list (CoinGecko's per-chain all.json carries
 *                        arbitrary logoURI strings) is checked before it is fetched, so a poisoned
 *                        entry can never turn the route into an open proxy.
 *   • raster only      — an SVG served from our origin could carry script if opened directly.
 *   • size / time cap  — ≤ 512 KB read incrementally, 5 s for the whole exchange.
 *   • redirects        — followed by hand, max 2 hops, each hop re-checked against the allow-list.
 *
 * @internal — server-only. Never import from client code (see no-browser-third-party.test.ts).
 */

import { NextResponse } from 'next/server'

/** The only hosts a logo may be fetched from. Exact hostnames, never suffix matches. */
const LOGO_HOSTS: ReadonlySet<string> = new Set([
  'raw.githubusercontent.com', // Trust Wallet assets
  'assets.coingecko.com', // CoinGecko images (per-chain list logoURI)
  'coin-images.coingecko.com', // CoinGecko images (newer host)
  'token-icons.llamao.fi', // DefiLlama by-address icons
])

/** Raster only. */
const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** Logos are ~5–30 KB; anything far beyond that is not a logo. */
export const MAX_LOGO_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 5_000
const MAX_REDIRECTS = 2

/** A confirmed logo: cached for a day at the edge and in the browser. */
export const LOGO_CACHE_CONTROL = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800'
/** A fallback source (may be a stale or generic icon): pinned for an hour only. */
export const LOGO_FALLBACK_CACHE_CONTROL = 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400'
/** A miss is cached for an hour at the edge, so a token without a logo is not re-fetched per view. */
export const MISS_CACHE_CONTROL = 'public, s-maxage=3600'

export interface FetchedLogo {
  body: Uint8Array<ArrayBuffer>
  contentType: string
}

/** True when `raw` is an https URL on an allow-listed host, default port, no embedded credentials. */
export function isAllowedLogoUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    LOGO_HOSTS.has(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  )
}

/** Read a body incrementally and give up as soon as it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(new ArrayBuffer(total))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Fetch one logo from an allow-listed host. Returns null on EVERYTHING that is not a small raster
 * image — a disallowed URL, a non-2xx, a timeout, a wrong content-type, an oversized body. Never
 * throws: a missing logo is cosmetic and <TokenLogo> walks on to its next candidate.
 */
export async function fetchLogo(url: string): Promise<FetchedLogo | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let target = url
    for (let hop = 0; ; hop++) {
      if (!isAllowedLogoUrl(target)) return null
      const upstream = await fetch(target, { signal: controller.signal, redirect: 'manual' })

      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get('location')
        if (!location || hop >= MAX_REDIRECTS) return null
        target = new URL(location, target).toString()
        continue
      }
      if (!upstream.ok) return null

      const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) return null
      if (Number(upstream.headers.get('content-length') ?? 0) > MAX_LOGO_BYTES) return null

      const body = await readCapped(upstream, MAX_LOGO_BYTES)
      return body ? { body, contentType } : null
    }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Stream a fetched logo back from our own origin. */
export function logoResponse(logo: FetchedLogo, cacheControl: string = LOGO_CACHE_CONTROL): NextResponse {
  return new NextResponse(logo.body, {
    status: 200,
    headers: {
      'Content-Type': logo.contentType,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  })
}

/** A logo that could not be resolved: a cached, empty 404. */
export function logoMiss(): NextResponse {
  return new NextResponse(null, { status: 404, headers: { 'Cache-Control': MISS_CACHE_CONTROL } })
}
