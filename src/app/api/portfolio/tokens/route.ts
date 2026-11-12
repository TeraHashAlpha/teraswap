import { NextResponse, type NextRequest } from 'next/server'
import { isValidAddress } from '@/lib/validation'
import { checkRateLimit } from '@/lib/kv-rate-limiter'
import { DEFAULT_TOKENS, type Token } from '@/lib/tokens'
import { DEFAULT_CHAIN_ID } from '@/lib/chains/registry'
import { getChainTokenList, getFullCatalog } from '@/lib/chains/tokens'
import { NATIVE_ETH } from '@/lib/constants'
import { ALCHEMY_BASE_BY_CHAIN, isPortfolioSupportedChain } from '@/lib/portfolio-chains'
import { clientIpKey } from '@/lib/client-ip-key'

/**
 * GET /api/portfolio/tokens?address=<0x..>
 *
 * Discovers every ERC-20 the connected wallet holds via Alchemy's
 * Enhanced API (`alchemy_getTokenBalances` + `alchemy_getTokenMetadata`).
 * Replaces the DEFAULT_TOKENS-only multicall path that was the original
 * Sprint 31 implementation.
 *
 * [fix/portfolio-tokens-view] Follows `pageKey` (<= MAX_BALANCE_PAGES pages of 100). When the scan cannot reach the end of the
 * wallet it adds one batched balance check of the chain's catalog addresses, ranks catalog holdings ahead of unknown ones when
 * trimming to MAX_TOKENS, and answers `truncated: true` so the UI can say the list may be incomplete.
 *
 * The endpoint is server-side so the Alchemy key never reaches the
 * browser. When the key is unset we return 503 — the consuming hook
 * (usePortfolio) treats that as the signal to fall back to the
 * multicall path so the Portfolio tab keeps working.
 */

// [E-3] Per-chain Alchemy endpoints — discovery follows the wallet's active
// chain. Mainnet (DEFAULT_CHAIN_ID) keeps the original endpoint byte-identically;
// an unmapped chainId is rejected with 400 before any upstream call.
// [CHORE-POLISH-3 P2] The endpoint map + chain allowlist now live in the
// shared @/lib/portfolio-chains module — ONE source for BOTH portfolio routes.
const TOKENS_RATE_LIMIT = { limit: 5, windowMs: 60_000 } as const
const MAX_TOKENS = 200
const METADATA_CONCURRENCY = 20
const ALCHEMY_TIMEOUT_MS = 5_000
// [fix/portfolio-tokens-view] alchemy_getTokenBalances('erc20') returns at most 100 entries per call (docs: `maxCount`
// "capped at 100") plus a `pageKey` for the rest. A wallet flooded with airdropped junk can hold thousands of entries, so the
// scan is bounded in pages AND in wall-clock; whatever it cannot reach is covered for CATALOG tokens by one batched check.
const BALANCES_PAGE_SIZE = 100
const MAX_BALANCE_PAGES = 5
const PAGING_BUDGET_MS = 8_000
const CATALOG_CHECK_CHUNK = 100

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

// The chain's FULL verified catalog (curated + long tail), lowercase address to token. `curatedFor` is only the "suggested" subset
// on Base / Arbitrum; a verified long-tail holding must still outrank an unknown one when the list is trimmed. The native-ETH
// sentinel is not a contract and is never part of an ERC-20 balance query.
const catalogByChain = new Map<number, Map<string, Token>>()
function catalogFor(chainId: number): Map<string, Token> {
  let m = catalogByChain.get(chainId)
  if (!m) {
    m = new Map<string, Token>()
    const native = NATIVE_ETH.toLowerCase()
    for (const t of getFullCatalog(chainId)) {
      const a = t.address.toLowerCase()
      if (a !== native) m.set(a, t)
    }
    catalogByChain.set(chainId, m)
  }
  return m
}

interface AlchemyBalance {
  contractAddress: string
  tokenBalance: string | null
  error?: string | null
}

interface AlchemyBalancesResult {
  address: string
  tokenBalances: AlchemyBalance[]
  pageKey?: string | null
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

/**
 * Follow `pageKey` from `alchemy_getTokenBalances(address, 'erc20')`. Page 1 failing throws (the route answers 502, as before).
 * A later page failing, the page cap or the time budget stops the scan and marks it `complete: false`; what was read is kept.
 */
async function fetchBalancePages(
  url: string,
  address: string,
): Promise<{ balances: AlchemyBalance[]; complete: boolean }> {
  const started = Date.now()
  const balances: AlchemyBalance[] = []
  let pageKey: string | null | undefined
  for (let page = 0; page < MAX_BALANCE_PAGES; page++) {
    if (page > 0 && Date.now() - started > PAGING_BUDGET_MS) return { balances, complete: false }
    const options: { maxCount: number; pageKey?: string } = { maxCount: BALANCES_PAGE_SIZE }
    if (pageKey) options.pageKey = pageKey
    let result: AlchemyBalancesResult
    try {
      result = await alchemyCall<AlchemyBalancesResult>(url, 'alchemy_getTokenBalances', [address, 'erc20', options])
    } catch (err) {
      if (page === 0) throw err
      console.warn('[portfolio-tokens] Alchemy getTokenBalances page', page + 1, 'failed:', err instanceof Error ? err.message : err)
      return { balances, complete: false }
    }
    const rows = result.tokenBalances ?? []
    for (const b of rows) balances.push(b)
    pageKey = result.pageKey
    // The docs describe `pageKey` only as a request option ("used for pagination if more results are available") and show
    // no `pageKey` in the response. A last page with no key AND fewer than a full page proves the end; a FULL page with no key
    // does not (the API might simply not hand the key back), so it is treated as incomplete and the catalog check covers it.
    if (!pageKey) return { balances, complete: rows.length < BALANCES_PAGE_SIZE }
  }
  return { balances, complete: false }
}

/**
 * ONE explicit balance check for the chain's catalog tokens, batched in chunks (the address-array form of the same method). Used
 * only when the page scan could not reach the end of the wallet, so a token we list in the catalog can never be missing because
 * of junk ahead of it. A failing chunk is skipped: the response is then still `truncated`.
 */
async function fetchCatalogBalances(url: string, address: string, chainId: number): Promise<AlchemyBalance[]> {
  const addresses = [...catalogFor(chainId).keys()]
  const chunks: string[][] = []
  for (let i = 0; i < addresses.length; i += CATALOG_CHECK_CHUNK) chunks.push(addresses.slice(i, i + CATALOG_CHECK_CHUNK))
  const settled = await Promise.allSettled(
    chunks.map((chunk) => alchemyCall<AlchemyBalancesResult>(url, 'alchemy_getTokenBalances', [address, chunk])),
  )
  const out: AlchemyBalance[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      for (const b of s.value.tokenBalances ?? []) out.push(b)
    } else {
      console.warn('[portfolio-tokens] catalog balance check chunk failed:', s.reason instanceof Error ? s.reason.message : s.reason)
    }
  }
  return out
}

function isNonZero(b: AlchemyBalance): boolean {
  return !!b.tokenBalance && hexToDecimalString(b.tokenBalance) !== '0'
}

// ── Route handler ──────────────────────────────────────────

export async function GET(req: NextRequest) {
  // [fix/user-ip-privacy] Was the raw LEFT-MOST x-forwarded-for token: client-writable (anyone could dodge the
  // limit or burn someone else's bucket — trusted-ip.ts) and stored / logged as a raw IP. Now the keyed hash of the
  // TRUSTED client IP.
  const ip = clientIpKey(req)
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
  if (!isPortfolioSupportedChain(chainId)) {
    return NextResponse.json(
      { error: `Chain ${chainIdParam} is not supported for portfolio discovery` },
      { status: 400 },
    )
  }
  const alchemyBase = ALCHEMY_BASE_BY_CHAIN[chainId]

  const apiKey = process.env.ALCHEMY_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Token discovery unavailable. Configure ALCHEMY_API_KEY.' },
      { status: 503 },
    )
  }

  const url = `${alchemyBase}/${apiKey}`
  const curated = curatedFor(chainId)

  const catalog = catalogFor(chainId)

  let scan: { balances: AlchemyBalance[]; complete: boolean }
  try {
    scan = await fetchBalancePages(url, address)
  } catch (err) {
    console.warn('[portfolio-tokens] Alchemy getTokenBalances failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'Token discovery temporarily unavailable.' },
      { status: 502 },
    )
  }

  // `truncated` = the list may be missing holdings (scan cut short, or trimmed to MAX_TOKENS).
  let truncated = !scan.complete
  const merged = new Map<string, AlchemyBalance>()
  for (const b of scan.balances) merged.set(b.contractAddress.toLowerCase(), b)
  if (!scan.complete) {
    for (const b of await fetchCatalogBalances(url, address, chainId)) merged.set(b.contractAddress.toLowerCase(), b)
  }

  // Catalog tokens first (curated, then the rest of the verified catalog), unknown ones after; the sort is stable.
  const rank = (b: AlchemyBalance): number => {
    const a = b.contractAddress.toLowerCase()
    return curated.has(a) ? 0 : catalog.has(a) ? 1 : 2
  }
  let nonZero = [...merged.values()].filter(isNonZero).sort((x, y) => rank(x) - rank(y))
  if (nonZero.length > MAX_TOKENS) {
    nonZero = nonZero.slice(0, MAX_TOKENS)
    truncated = true
  }

  if (nonZero.length === 0) {
    return NextResponse.json(
      { tokens: [], truncated },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
          'X-RateLimit-Remaining': String(rateCheck.remaining),
        },
      },
    )
  }

  // Split into KNOWN (curated or in the verified catalog) and UNKNOWN — only the unknown
  // set needs the metadata round trip. This keeps Alchemy compute units
  // proportional to wallets that hold long-tail tokens.
  const unknownAddrs: string[] = []
  for (const b of nonZero) {
    if (rank(b) === 2) {
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
    const known = curated.get(addr) ?? catalog.get(addr)
    if (known) {
      return {
        address: addr,
        symbol: known.symbol,
        name: known.name,
        decimals: known.decimals,
        logoURI: known.logoURI,
        balance: hexToDecimalString(b.tokenBalance),
        isDefault: curated.has(addr),
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
    { tokens, truncated },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        'X-RateLimit-Remaining': String(rateCheck.remaining),
        'X-RateLimit-Reset': String(rateCheck.resetAt),
      },
    },
  )
}
