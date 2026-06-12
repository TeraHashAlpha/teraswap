import { NextResponse, type NextRequest } from 'next/server'
import { fetchDefiLlamaPrices } from '@/lib/defillama'
import { isValidAddress } from '@/lib/validation'
import { checkRateLimit } from '@/lib/kv-rate-limiter'
import { DEFAULT_CHAIN_ID, getChainConfig } from '@/lib/chains/registry'
import { isPortfolioSupportedChain } from '@/lib/portfolio-chains'

/**
 * GET /api/portfolio/prices?tokens=<addr1,addr2,...>
 *
 * Returns USD prices for a list of Ethereum mainnet token addresses,
 * sourced from DefiLlama (5-min cached, ~2-min cache in defillama.ts).
 *
 * Why server-side: the DefiLlama call would otherwise expose the user's
 * IP directly to coins.llama.fi. This route also lets us layer rate
 * limiting and edge caching on top.
 *
 * Response: { prices: Record<string, number> } — addresses are lower-cased.
 * Missing/unpriced tokens are simply absent from the map (not null).
 */

// Rate limit kept local (10 req/min per IP) — this endpoint is cheap and
// hit at most once per refresh interval on the Portfolio tab.
const PORTFOLIO_PRICES_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const

// Cap the number of addresses per call so a malicious caller can't drive
// a 1000-element DefiLlama fetch through us.
const MAX_TOKENS_PER_REQUEST = 100

export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rateCheck = await checkRateLimit(
    `portfolio-prices:${ip}`,
    PORTFOLIO_PRICES_RATE_LIMIT.limit,
    PORTFOLIO_PRICES_RATE_LIMIT.windowMs,
  )
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in a minute.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetAt),
        },
      },
    )
  }

  const tokensParam = req.nextUrl.searchParams.get('tokens')
  if (!tokensParam) {
    return NextResponse.json(
      { error: 'Missing required param: tokens' },
      { status: 400 },
    )
  }

  const raw = tokensParam
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  if (raw.length === 0) {
    return NextResponse.json(
      { error: 'tokens param must contain at least one address' },
      { status: 400 },
    )
  }

  if (raw.length > MAX_TOKENS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many tokens. Max ${MAX_TOKENS_PER_REQUEST} per request.` },
      { status: 400 },
    )
  }

  for (const addr of raw) {
    if (!isValidAddress(addr)) {
      return NextResponse.json(
        { error: `Invalid token address format: ${addr}` },
        { status: 400 },
      )
    }
  }

  // [E-3] Active-chain param → DefiLlama slug via the chain registry. Absent →
  // mainnet 'ethereum' (byte-identical for existing callers); unsupported → 400.
  // [CHORE-POLISH-3 P2] Validates against the SAME shared allowlist as the
  // tokens route (@/lib/portfolio-chains) — the two can no longer drift.
  const chainIdParam = req.nextUrl.searchParams.get('chainId')
  const chainId = chainIdParam != null && chainIdParam !== '' ? Number(chainIdParam) : DEFAULT_CHAIN_ID
  if (!isPortfolioSupportedChain(chainId)) {
    return NextResponse.json(
      { error: `Chain ${chainIdParam} is not supported for portfolio prices` },
      { status: 400 },
    )
  }
  const chainSlug = getChainConfig(chainId).slug

  // De-duplicate (lowercase) before hitting DefiLlama.
  const addresses = Array.from(new Set(raw.map((a) => a.toLowerCase())))

  try {
    const result = await fetchDefiLlamaPrices(addresses, chainSlug)
    const prices: Record<string, number> = {}
    for (const [addr, data] of result) {
      prices[addr.toLowerCase()] = data.price
    }

    return NextResponse.json(
      { prices },
      {
        headers: {
          // 60s shared cache on the edge, with 2-min SWR window. Matches
          // the 60s refresh cadence in usePortfolio without amplifying
          // load on DefiLlama under cold-start storms.
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
          'X-RateLimit-Remaining': String(rateCheck.remaining),
          'X-RateLimit-Reset': String(rateCheck.resetAt),
        },
      },
    )
  } catch {
    // fetchDefiLlamaPrices is best-effort and already swallows its own
    // failures; this is just a belt-and-braces guard so a thrown error
    // from a future change doesn't 500 the portfolio tab.
    return NextResponse.json(
      { prices: {} },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
