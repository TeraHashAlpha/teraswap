/**
 * [ADR-029, details B] The symbol a swap row stores is the token catalog's symbol for that address ON THAT CHAIN.
 * The caller's symbol text is never stored (an XSS string and a NUL byte were stored as symbols in the incident of
 * 2026-11-20). An address the catalog does not have gets a fixed short label built from the address itself.
 */
import { getFullCatalog } from '@/lib/chains/tokens'

const symbolsByChain = new Map<number, Map<string, string>>()

function symbolsOf(chainId: number): Map<string, string> {
  let map = symbolsByChain.get(chainId)
  if (!map) {
    map = new Map()
    // First entry wins: the catalog lists a chain's curated tokens before its long tail.
    for (const token of getFullCatalog(chainId)) {
      const address = token.address.toLowerCase()
      if (!map.has(address)) map.set(address, token.symbol)
    }
    symbolsByChain.set(chainId, map)
  }
  return map
}

/** `0x1234...abcd`: the first 6 and the last 4 characters of the (lowercase) address. */
export function shortAddressLabel(address: string): string {
  const lower = address.toLowerCase()
  return `${lower.slice(0, 6)}...${lower.slice(-4)}`
}

/** The catalog symbol of `address` on `chainId`, else the short label. `address` must already be a validated address. */
export function catalogSymbol(address: string, chainId: number): string {
  return symbolsOf(chainId).get(address.toLowerCase()) ?? shortAddressLabel(address)
}

/** As `catalogSymbol`, for a side that may not be derivable: a null token has a null symbol. */
export function catalogSymbolOrNull(address: string | null, chainId: number): string | null {
  return address === null ? null : catalogSymbol(address, chainId)
}
