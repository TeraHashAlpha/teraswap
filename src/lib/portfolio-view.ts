import { CATEGORY_DISPLAY_ORDER, type TokenCategory } from '@/lib/tokens'
import { getFullCatalog, isCuratedToken } from '@/lib/chains/tokens'
import type { PortfolioToken } from '@/hooks/usePortfolio'

/**
 * [fix/portfolio-tokens-view] What the Portfolio tab shows, decided ONCE for v1 and v2 (v2 imports v1's logic rather than forking it, and
 * the parity sweep compares the rendered text). Display only: nothing here prices, signs, swaps or changes the catalog, and the total
 * value shown in the header is the hook's `totalValueUsd`, untouched, whatever this view hides.
 */

// ── Wording (one copy for both UIs) ─────────────────────────────────────────

/** Shown when /api/portfolio/tokens answered `truncated: true`: catalog tokens are complete, the long tail may not be. */
export const PORTFOLIO_TRUNCATED_NOTE = 'This wallet holds a very large number of tokens, so the list may be incomplete.'
export const HIDE_SMALL_LABEL = 'Hide small balances'
export const showAllLabel = (hidden: number): string => `Show all tokens (${hidden} hidden)`
export const ALL_HIDDEN_NOTE = 'No token in this wallet is worth $1.00 or more.'
export const UNVERIFIED_TOKEN_NAME = 'Unverified token'
export const THIRD_PARTY_NOTE = 'Sent to your wallet by third parties. TeraSwap has not verified these tokens.'

// ── Small balances ──────────────────────────────────────────────────────────

/** A holding worth less than this (USD) is hidden by default. A holding with no price counts as below it. */
export const SMALL_BALANCE_USD = 1

export function isSmallBalance(valueUsd: number | null): boolean {
  return !(valueUsd !== null && valueUsd >= SMALL_BALANCE_USD) // null and NaN are "below $1"
}

// ── Catalog membership and junk metadata ────────────────────────────────────

const catalogSets = new Map<number, Set<string>>()
/** In the chain's full verified catalog (curated or long tail). Session imports are NOT catalog. */
function inCatalog(address: string, chainId: number): boolean {
  let set = catalogSets.get(chainId)
  if (!set) {
    set = new Set(getFullCatalog(chainId).map((t) => t.address.toLowerCase()))
    catalogSets.set(chainId, set)
  }
  return set.has(address.toLowerCase()) || isCuratedToken(address, chainId)
}

// A URL, a domain, a Telegram / Discord handle, the words airdrop spam uses, an emoji, or an invisible format character.
const JUNK_PATTERNS: readonly RegExp[] = [
  /https?:|www\./i,
  /[a-z0-9][a-z0-9-]*\.[a-z]{2,}/i, // domain: label.tld (t.me/..., claim-uni.xyz, ether.fi)
  /\bt\.me\b|\btelegram\b|\bdiscord\b|\bdiscord\.gg\b/i,
  /@[a-z0-9_]{3,}/i, // @handle
  /claim|airdrop|visit/i,
  /\p{Extended_Pictographic}|\p{Regional_Indicator}/u, // emoji
  /\p{Cf}/u, // zero-width / bidi controls
]

/** True for token metadata we refuse to render: name or symbol looks like an advert. */
export function looksLikeJunkMetadata(name: string, symbol: string): boolean {
  return JUNK_PATTERNS.some((re) => re.test(name) || re.test(symbol))
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ── The view ────────────────────────────────────────────────────────────────

export interface RowView {
  entry: PortfolioToken
  /** Not in the chain's catalog: carries THIRD_PARTY_NOTE. */
  nonCatalog: boolean
  /** Not in the catalog AND the metadata looks like junk: the raw name / symbol is never rendered. */
  masked: boolean
  /** What to call the token on screen and in accessible names: the symbol, or "Unverified token <short address>". */
  label: string
  /** The name line: the token's name, or the short address when masked. */
  subtitle: string
}

export interface PortfolioViewModel {
  grouped: Array<[TokenCategory, RowView[]]>
  discovered: RowView[]
  /** Holdings below $1 or unpriced, whether or not they are shown right now. */
  smallCount: number
  /** Rows on screen. */
  visibleCount: number
}

function categoryIndex(cat: TokenCategory): number {
  const idx = CATEGORY_DISPLAY_ORDER.indexOf(cat)
  return idx === -1 ? CATEGORY_DISPLAY_ORDER.length : idx
}

function rowView(entry: PortfolioToken, chainId: number): RowView {
  const { token } = entry
  const nonCatalog = !inCatalog(token.address, chainId)
  const masked = nonCatalog && looksLikeJunkMetadata(token.name ?? '', token.symbol ?? '')
  const short = shortAddress(token.address)
  return {
    entry,
    nonCatalog,
    masked,
    label: masked ? `${UNVERIFIED_TOKEN_NAME} ${short}` : token.symbol,
    subtitle: masked ? short : token.name,
  }
}

/** Largest USD value first; unpriced last, by displayed name (then address, so the order is total and stable). */
function byValueThenName(a: RowView, b: RowView): number {
  const av = a.entry.valueUsd
  const bv = b.entry.valueUsd
  const aPriced = av !== null && Number.isFinite(av)
  const bPriced = bv !== null && Number.isFinite(bv)
  if (aPriced && bPriced && av !== bv) return (bv as number) - (av as number)
  if (aPriced !== bPriced) return aPriced ? -1 : 1
  const an = a.masked ? UNVERIFIED_TOKEN_NAME : a.entry.token.name
  const bn = b.masked ? UNVERIFIED_TOKEN_NAME : b.entry.token.name
  return an.localeCompare(bn) || a.entry.token.address.toLowerCase().localeCompare(b.entry.token.address.toLowerCase())
}

/**
 * Curated tokens bucketed by category (CATEGORY_DISPLAY_ORDER), the rest under "Discovered in Wallet" (the v1 split, per ACTIVE chain).
 * Rows inside each section are sorted by USD value; unless `showAll`, holdings worth less than $1 (or unpriced) are left out.
 */
export function buildPortfolioView(tokens: readonly PortfolioToken[], chainId: number, showAll: boolean): PortfolioViewModel {
  const buckets = new Map<TokenCategory, RowView[]>()
  const discovered: RowView[] = []
  let smallCount = 0
  for (const entry of tokens) {
    const small = isSmallBalance(entry.valueUsd)
    if (small) smallCount += 1
    if (small && !showAll) continue
    const row = rowView(entry, chainId)
    if (isCuratedToken(entry.token.address, chainId)) {
      const list = buckets.get(entry.token.category) ?? []
      list.push(row)
      buckets.set(entry.token.category, list)
    } else {
      discovered.push(row)
    }
  }
  const grouped = Array.from(buckets.entries())
    .sort(([a], [b]) => categoryIndex(a) - categoryIndex(b))
    .map(([cat, rows]): [TokenCategory, RowView[]] => [cat, rows.sort(byValueThenName)])
  discovered.sort(byValueThenName)
  const visibleCount = discovered.length + grouped.reduce((n, [, rows]) => n + rows.length, 0)
  return { grouped, discovered, smallCount, visibleCount }
}
