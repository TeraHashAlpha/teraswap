/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Stable import surface over the committed cross-verified
 * catalogs. The DATA lives in src/config/generated/token-catalog.<chainId>.json, built by
 * `npm run tokens:sync` (scripts/token-catalog/build.ts): multi-source discovery
 * (uniswap / coingecko / 1inch / trustwallet / superchain[Base] + the DefiLlama market
 * signal), >=2-source agreement on the (chainId, EIP-55 address), and a PASS from the
 * catalog guard (bytecode / on-chain identity / FATAL decimals cross-check / trusted-list /
 * duplicate-symbol — PRs #209–#211, reused via the shared verdict collector).
 *
 * Supersedes the SPRINT-9Y single-source pin (scripts/generate-token-catalog.mjs over the
 * vendored Uniswap snapshot). The GeneratedToken import surface is preserved for existing
 * consumers/tests; every row now carries the REAL verified/sources fields that drive the
 * ✓ badge (isVerifiedToken reads them — membership no longer implies verified).
 */
import catalog1 from '@/config/generated/token-catalog.1.json'
import catalog8453 from '@/config/generated/token-catalog.8453.json'

export interface GeneratedToken {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  /** Local core asset (/tokens/*.png) or the /api/token-logo route — both CSP 'self'. */
  logoURI: string
  category: string
  /** REAL cross-verification flag: source agreement + catalog-guard PASS. */
  verified: boolean
  /** Sources that agreed on this (chainId, address) at build time. */
  sources: string[]
  /** Pinned fee/routing-critical core (always present, fail-closed validated). */
  core?: boolean
}

interface CatalogFile {
  chainId: number
  tokens: GeneratedToken[]
}

function rows(file: unknown): GeneratedToken[] {
  return (file as CatalogFile).tokens
}

export const GENERATED_TOKEN_CATALOG: Record<number, GeneratedToken[]> = {
  1: rows(catalog1),
  8453: rows(catalog8453),
}
