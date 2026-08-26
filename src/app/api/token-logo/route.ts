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
 *   GET /api/token-logo?chainId=<any chain in the registry>&address=<0x..40hex>
 *     → 302 redirect to the resolved logo:
 *         • CoinGecko logoURI when the address is in the per-chain list (cached long),
 *         • else the DefiLlama by-address CDN (cached shorter — it may itself 404,
 *           at which point <TokenLogo> advances to its next candidate client-side).
 *     → 400 on a chainId the chain registry does not know, or a malformed address.
 *
 * Fail-safe: ANY fetch/parse error on the CoinGecko list falls back to the DefiLlama
 * redirect. This route NEVER 500s on a logo lookup — a missing logo is cosmetic.
 *
 * The per-chain list is cached IN MEMORY at module scope (one Map per chain, ~12h
 * TTL) so a warm instance fetches each ~1MB list at most once per TTL window.
 *
 * [FIX-RPC-CHAIN-IDENTITY-GUARD] The accepted chains come from the CHAIN REGISTRY, not from a
 * hardcoded pair. This route 400'd for chainId=42161 while Arbitrum had been a supported chain
 * since SPRINT-46, so every Arbitrum token silently lost its logo. A chain the registry knows is
 * served; a chain it does not know is still rejected.
 *
 * @internal — server-only route. Reads only; no auth, no fund flow, no state write.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupportedChainIds } from '@/lib/chains/registry'

export const dynamic = 'force-dynamic'

/**
 * Validate the raw `chainId` param against the chain registry and return it as a NUMBER.
 *
 * The digits-only test runs FIRST and is what preserves the CodeQL js/remote-property-injection
 * property the old literal comparison gave us: a crafted `__proto__` / `constructor` / `prototype`
 * never survives it, so it can never reach a lookup or become a cache key. Everything downstream
 * then works on a validated number, and every container it touches is a Map.
 */
function resolveChainId(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null
  const chainId = Number(raw)
  return getSupportedChainIds().includes(chainId) ? chainId : null
}

/**
 * chainId → CoinGecko asset-platform slug. A Map (never a plain object) so no key can reach a
 * prototype property. Note these are CoinGecko's slugs, not the registry's: Arbitrum One is
 * `arbitrum-one` upstream but `arbitrum` in our own config, so this cannot be derived from
 * ChainConfig.slug.
 *
 * A registry chain ABSENT from this map is NOT an error: `getChainMap` returns null and the
 * request falls through to the chain-agnostic DefiLlama CDN. CoinGecko simply does not publish a
 * per-chain list for every chain, and a missing logo is cosmetic — it must never become a 400.
 */
const COINGECKO_PLATFORM = new Map<number, string>([
  [1, 'ethereum'],
  [8453, 'base'],
  [42161, 'arbitrum-one'],
])

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

// Module-level cache keyed by the VALIDATED numeric chainId. A Map (not a plain object) so a
// user-supplied chainId can never write to a prototype property. Lives for a warm instance's life.
const listCache = new Map<number, ChainListCache>()

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
function defiLlamaUrl(chainId: number, address: string): string {
  return `https://token-icons.llamao.fi/icons/tokens/${chainId}/${address.toLowerCase()}?h=48&w=48`
}

/**
 * Resolve (and memoise) the address→logoURI map for a chain from CoinGecko's
 * per-chain `all.json`. Returns null on any fetch/parse failure so the caller can
 * fall back. Never throws.
 */
async function getChainMap(chainId: number): Promise<Map<string, string> | null> {
  const cached = listCache.get(chainId)
  if (cached && Date.now() - cached.fetchedAt < LIST_TTL_MS) {
    return cached.map
  }

  // No CoinGecko list for this chain — not a failure, just no shortcut. Fall through to DefiLlama.
  const platform = COINGECKO_PLATFORM.get(chainId)
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

/**
 * CoinGecko serves three size variants per coin image at
 * `.../coins/images/<id>/{thumb,small,large}/<file>`. The per-chain list's logoURI is the
 * 25px `thumb` — too low-res for the token selector (logos look blurry/empty on the dark UI).
 * Rewrite it to the 250px `large` variant, which is present whenever `thumb` is. Only touches
 * CoinGecko-hosted URLs (assets/coin-images) and only when a `/thumb/` segment exists; any other
 * URL passes through verbatim. Plain string ops (no URL re-encoding) so query/encoded names survive.
 */
function upgradeCoinGeckoLogo(url: string): string {
  if (
    (url.startsWith('https://assets.coingecko.com/') ||
      url.startsWith('https://coin-images.coingecko.com/')) &&
    url.includes('/thumb/')
  ) {
    return url.replace('/thumb/', '/large/')
  }
  return url
}

/** Build the 302 redirect with the given Cache-Control header. */
function redirect(target: string, cacheControl: string): NextResponse {
  const res = NextResponse.redirect(target, 302)
  res.headers.set('Cache-Control', cacheControl)
  return res
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address') ?? ''

  // ① Validate — any chain the registry supports, and a well-formed address.
  const chainId = resolveChainId(searchParams.get('chainId') ?? '')
  if (chainId === null) {
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
    return redirect(upgradeCoinGeckoLogo(cgLogo), CG_CACHE_CONTROL)
  }

  // ③ Fall back to DefiLlama by-address (also covers a failed list fetch).
  return redirect(defiLlamaUrl(chainId, lower), DL_CACHE_CONTROL)
}
