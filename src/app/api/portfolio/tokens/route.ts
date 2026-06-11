import { NextResponse, type NextRequest } from 'next/server'
import { isValidAddress } from '@/lib/validation'
import { checkRateLimit } from '@/lib/kv-rate-limiter'
import { DEFAULT_TOKENS, type Token } from '@/lib/tokens'
import { DEFAULT_CHAIN_ID } from '@/lib/chains/registry'
import { getChainTokenList } from '@/lib/chains/tokens'

/**
 * GET /api/portfolio/tokens?address=<0x..>
 *
 * Discovers every ERC-20 the connected wallet holds via Alchemy's
 * Enhanced API (`alchemy_getTokenBalances` + `alchemy_getTokenMetadata`).
 * Replaces the DEFAULT_TOKENS-only multicall path that was the original
 * Sprint 31 implementation.
 *
 * The endpoint is server-side so the Alchemy key never reaches the
 * browser. When the key is unset we return 503 — the consuming hook
 * (usePortfolio) treats that as the signal to fall back to the
 * multicall path so the Portfolio tab keeps working.
 */

// [E-3] Per-chain Alchemy endpoints — discovery now follows the wallet's active
// chain. Mainnet (DEFAULT_CHAIN_ID) keeps the original endpoint byte-identically;
// an unmapped chainId is rejected with 400 before any upstream call.
const ALCHEMY_BASE_BY_CHAIN: Record<number, string> = {
  1: 'https://eth-mainnet.g.alchemy.com/v2',
  8453: 'https://base-mainnet.g.alchemy.com/v2',
}
const TOKENS_RATE_LIMIT = { limit: 5, windowMs: 60_000 } as const
const MAX_TOKENS = 200
const METADATA_CONCURRENCY = 20
const ALCHEMY_TIMEOUT_MS = 5_000

export interface DiscoveredToken {
  address: string
  symbol: string
  name: string
  decimals: number
  logoURI: string | null
  balance: string
  isDefault: boolean
}

// ── Helpers ────────────────────────────────────────────────

// [E-3] Per-chain curated map: mainnet keeps the canonical DEFAULT_TOKENS;
// other chains curate from their own catalog (a Base address must never be
// labeled with mainnet metadata — the 9P cross-chain-address lesson).
const curatedByChain = new Map<number, Map<string, Token>>()
function curatedFor(chainId: number): Map<string, Token> {
  let m = curatedByChain.get(chainId)
  if (!m) {
    const list = chainId === DEFAULT_CHAIN_ID ? DEFAULT_TOKENS : getChainTokenList(chainId)
    m = new Map<string, Token>()
    for (const t of list) m.set(t.address.toLowerCase(), t)
    curatedByChain.set(chainId, m)
  }
  return m
}

interface AlchemyBalance {
  contractAddress: string
  tokenBalance: string | null
  error?: string | null
}

interface AlchemyMetadata {
  decimals: number | null
  logo: string | null
  name: string | null
  symbol: string | null
}

async function alchemyCall<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ALCHEMY_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`Alchemy ${method} HTTP ${res.status}`)
    }
    const json = (await res.json()) as { result?: T; error?: { message?: string } }
    if (json.error) {
      throw new Error(`Alchemy ${method} error: ${json.error.message ?? 'unknown'}`)
    }
    if (json.result === undefined) {
      throw new Error(`Alchemy ${method}: empty result`)
    }
    return json.result
  } finally {
    clearTimeout(timeout)
  }
}

function hexToDecimalString(hex: string | null): string {
  if (!hex || hex === '0x') return '0'
  try {
    return BigInt(hex).toString(10)
  } catch {
    return '0'
  }
}

// Resolve metadata for unknown tokens in batches so we don't open 200
// fetches at once. Each batch resolves with allSettled — a single
// metadata failure must not poison the whole response.
async function resolveMetadataBatched(
  url: string,
  addresses: string[],
): Promise<Map<string, AlchemyMetadata>> {
  const out = new Map<string, AlchemyMetadata>()
  for (let i = 0; i < addresses.length; i += METADATA_CONCURRENCY) {
    const batch = addresses.slice(i, i + METADATA_CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map((addr) => alchemyCall<AlchemyMetadata>(url, 'alchemy_getTokenMetadata', [addr])),
    )
    settled.forEach((s, idx) => {
      if (s.status === 'fulfilled') {
        out.set(batch[idx], s.value)
      }
      // Fulfilled-with-falsy and rejected both fall through to the
      // fallback metadata constructed in the main path below.
    })
  }
  return out
}

function fallbackMetadataFor(address: string): AlchemyMetadata {
  return {
    decimals: 18,
    logo: null,
    name: 'Unknown Token',
    symbol: address.slice(0, 6),
  }
}

// ── Route handler ──────────────────────────────────────────

export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rateCheck = await checkRateLimit(
    `portfolio-tokens:${ip}`,
    TOKENS_RATE_LIMIT.limit,
    TOKENS_RATE_LIMIT.windowMs,
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

  const address = req.nextUrl.searchParams.get('address')
  if (!address) {
    return NextResponse.json(
      { error: 'Missing required param: address' },
      { status: 400 },
    )
  }
  if (!isValidAddress(address)) {
    return NextResponse.json(
      { error: 'Invalid address format' },
      { status: 400 },
    )
  }

  // [E-3] Active-chain param. Absent → mainnet (byte-identical for existing
  // callers); a chain without a mapped Alchemy endpoint is rejected up front.
  const chainIdParam = req.nextUrl.searchParams.get('chainId')
  const chainId = chainIdParam != null && chainIdParam !== '' ? Number(chainIdParam) : DEFAULT_CHAIN_ID
  const alchemyBase = ALCHEMY_BASE_BY_CHAIN[chainId]
  if (!Number.isInteger(chainId) || !alchemyBase) {
    return NextResponse.json(
      { error: `Chain ${chainIdParam} is not supported for portfolio discovery` },
      { status: 400 },
    )
  }

  const apiKey = process.env.ALCHEMY_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Token discovery unavailable. Configure ALCHEMY_API_KEY.' },
      { status: 503 },
    )
  }

  const url = `${alchemyBase}/${apiKey}`
  const curated = curatedFor(chainId)

  let balancesResult: { address: string; tokenBalances: AlchemyBalance[] }
  try {
    balancesResult = await alchemyCall(url, 'alchemy_getTokenBalances', [address, 'erc20'])
  } catch (err) {
    console.warn('[portfolio-tokens] Alchemy getTokenBalances failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'Token discovery temporarily unavailable.' },
      { status: 502 },
    )
  }

  const nonZero = (balancesResult.tokenBalances ?? [])
    .filter((b) => b.tokenBalance && b.tokenBalance !== '0x0' && b.tokenBalance !== '0x')
    .slice(0, MAX_TOKENS)

  if (nonZero.length === 0) {
    return NextResponse.json(
      { tokens: [] },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
          'X-RateLimit-Remaining': String(rateCheck.remaining),
        },
      },
    )
  }

  // Split into KNOWN (in DEFAULT_TOKENS) and UNKNOWN — only the unknown
  // set needs the metadata round trip. This keeps Alchemy compute units
  // proportional to wallets that hold long-tail tokens.
  const unknownAddrs: string[] = []
  for (const b of nonZero) {
    if (!curated.has(b.contractAddress.toLowerCase())) {
      unknownAddrs.push(b.contractAddress)
    }
  }

  let metadataByAddr = new Map<string, AlchemyMetadata>()
  if (unknownAddrs.length > 0) {
    try {
      metadataByAddr = await resolveMetadataBatched(url, unknownAddrs)
    } catch (err) {
      console.warn('[portfolio-tokens] metadata batch failed:', err instanceof Error ? err.message : err)
      // Individual failures already produce fallback metadata below.
      // A wholesale rejection here is unusual; we keep going with whatever
      // came back rather than 502'ing the response.
    }
  }

  const tokens: DiscoveredToken[] = nonZero.map((b) => {
    const addr = b.contractAddress.toLowerCase()
    const known = curated.get(addr)
    if (known) {
      return {
        address: addr,
        symbol: known.symbol,
        name: known.name,
        decimals: known.decimals,
        logoURI: known.logoURI,
        balance: hexToDecimalString(b.tokenBalance),
        isDefault: true,
      }
    }
    const meta = metadataByAddr.get(b.contractAddress) ?? fallbackMetadataFor(addr)
    return {
      address: addr,
      symbol: meta.symbol || fallbackMetadataFor(addr).symbol!,
      name: meta.name || 'Unknown Token',
      decimals: typeof meta.decimals === 'number' ? meta.decimals : 18,
      logoURI: meta.logo,
      balance: hexToDecimalString(b.tokenBalance),
      isDefault: false,
    }
  })

  return NextResponse.json(
    { tokens },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        'X-RateLimit-Remaining': String(rateCheck.remaining),
        'X-RateLimit-Reset': String(rateCheck.resetAt),
      },
    },
  )
}
