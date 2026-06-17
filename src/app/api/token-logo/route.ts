/**
 * /api/token-logo — read-only token logo resolver (server-side, chainId-aware).
 *
 * Why this route exists: the DefiLlama by-address endpoint, Trust Wallet and the
 * CoinGecko by-CONTRACT API all 404 for a meaningful long tail of mainnet tokens
 * (PENDLE/FRAX/LUSD/PYUSD, …). CoinGecko's comprehensive PER-CHAIN list
 * (`https://tokens.coingecko.com/<platform>/all.json`) DOES contain them with real
 * logoURIs — but it is ~1MB (eth) / ~0.5MB (base), so it must stay SERVER-SIDE
 * (never bundled/shipped to the client) and be served via this cached redirect.
 *
 *   GET /api/token-logo?chainId=<1|8453>&address=<0x..40hex>
 *     → 302 redirect to the resolved logo:
 *         • CoinGecko logoURI when the address is in the per-chain list (cached long),
 *         • else the DefiLlama by-address CDN (cached shorter — it may itself 404,
 *           at which point <TokenLogo> advances to its next candidate client-side).
 *     → 400 on a bad chainId (only 1 and 8453) or a malformed address.
 *
 * Fail-safe: ANY fetch/parse error on the CoinGecko list falls back to the DefiLlama
 * redirect. This route NEVER 500s on a logo lookup — a missing logo is cosmetic.
 *
 * The per-chain list is cached IN MEMORY at module scope (one Map per chain, ~12h
 * TTL) so a warm instance fetches each ~1MB list at most once per TTL window.
 *
 * @internal — server-only route. Reads only; no auth, no fund flow, no state write.
 */

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// chainId → CoinGecko asset-platform slug. A literal comparison (NOT a user-keyed
// object lookup) so a crafted chainId such as '__proto__' can never pass validation
// or be used as a cache key (js/remote-property-injection). Only '1' and '8453'.
function platformFor(chainId: string): 'ethereum' | 'base' | null {
  if (chainId === '1') return 'ethereum'
  if (chainId === '8453') return 'base'
  return null
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

// In-memory cache TTL for the per-chain CoinGecko list. 12h: the list changes
// slowly (new listings) and a stale logo URL is harmless.
const LIST_TTL_MS = 12 * 60 * 60 * 1000

// Long cache for a CoinGecko hit (a confirmed real, stable CDN logo URL).
const CG_CACHE_CONTROL =
  'public, s-maxage=86400, stale-while-revalidate=604800'
// Shorter cache for a DefiLlama fallback (the target may itself 404; don't pin it
// at the edge for a day).
const DL_CACHE_CONTROL =
  'public, s-maxage=3600, stale-while-revalidate=86400'

interface ChainListCache {
  map: Map<string, string>
  fetchedAt: number
}

// Module-level cache keyed by chainId. A Map (not a plain object) so a user-supplied
// chainId can never write to a prototype property. Lives for a warm instance's life.
const listCache = new Map<string, ChainListCache>()

/** Test-only: clear the module-level cache between cases. */
export function __resetTokenLogoCache(): void {
  listCache.clear()
}

interface CoinGeckoToken {
  address?: unknown
  logoURI?: unknown
}

/**
 * DefiLlama by-address CDN URL. Keyed by the LOWERCASE address (no checksum-casing
 * pitfall) and chainId-aware. Byte-for-byte the same shape <TokenLogo> uses for its
 * own DefiLlama candidate.
 */
function defiLlamaUrl(chainId: string, address: string): string {
  return `https://token-icons.llamao.fi/icons/tokens/${chainId}/${address.toLowerCase()}?h=48&w=48`
}

/**
 * Resolve (and memoise) the address→logoURI map for a chain from CoinGecko's
 * per-chain `all.json`. Returns null on any fetch/parse failure so the caller can
 * fall back. Never throws.
 */
async function getChainMap(chainId: string): Promise<Map<string, string> | null> {
  const cached = listCache.get(chainId)
  if (cached && Date.now() - cached.fetchedAt < LIST_TTL_MS) {
    return cached.map
  }

  const platform = platformFor(chainId)
  if (!platform) return null

  try {
    const res = await fetch(`https://tokens.coingecko.com/${platform}/all.json`)
    if (!res.ok) return null

    const data = (await res.json()) as { tokens?: CoinGeckoToken[] }
    const tokens = Array.isArray(data?.tokens) ? data.tokens : []

    const map = new Map<string, string>()
    for (const t of tokens) {
      if (
        typeof t?.address === 'string' &&
        typeof t?.logoURI === 'string' &&
        t.logoURI.length > 0
      ) {
        map.set(t.address.toLowerCase(), t.logoURI)
      }
    }

    listCache.set(chainId, { map, fetchedAt: Date.now() })
    return map
  } catch {
    // Network/parse error — fail-safe to DefiLlama at the call site.
    return null
  }
}

/** Build the 302 redirect with the given Cache-Control header. */
function redirect(target: string, cacheControl: string): NextResponse {
  const res = NextResponse.redirect(target, 302)
  res.headers.set('Cache-Control', cacheControl)
  return res
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url)
  const chainId = searchParams.get('chainId') ?? ''
  const address = searchParams.get('address') ?? ''

  // ① Validate — only the two supported chains and a well-formed address.
  if (!platformFor(chainId)) {
    return NextResponse.json({ error: 'invalid chainId' }, { status: 400 })
  }
  if (!ADDRESS_RE.test(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 })
  }

  const lower = address.toLowerCase()

  // ② CoinGecko per-chain list first (near-universal, real CDN logos).
  const map = await getChainMap(chainId)
  const cgLogo = map?.get(lower)
  if (cgLogo) {
    return redirect(cgLogo, CG_CACHE_CONTROL)
  }

  // ③ Fall back to DefiLlama by-address (also covers a failed list fetch).
  return redirect(defiLlamaUrl(chainId, lower), DL_CACHE_CONTROL)
}
