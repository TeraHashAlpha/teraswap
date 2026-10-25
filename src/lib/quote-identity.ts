/**
 * [fix/stale-quote-pair-flip] A quote carries the identity of the request it
 * answered, so a quote for one pair/chain can never be rendered or fed to a
 * gate as if it belonged to another (⇅ flip, token/chain change, late response).
 *
 * Pure helpers — no React, no network. Addresses are compared lowercased.
 */

export interface QuoteKey {
  chainId: number
  /** Lowercased token-in address. */
  tokenIn: string
  /** Lowercased token-out address. */
  tokenOut: string
  /** Raw input amount (base units, decimal string). */
  amountRaw: string
  decimalsIn: number
  decimalsOut: number
}

/** The key a stored quote is tagged with, plus when it was fetched. */
export interface QuoteIdentity extends QuoteKey {
  fetchedAt: number
}

interface TokenLike {
  address: string
  decimals: number
}

export function makeQuoteKey(p: {
  chainId: number
  tokenIn: string
  tokenOut: string
  amountRaw: string
  decimalsIn: number
  decimalsOut: number
}): QuoteKey {
  return {
    chainId: p.chainId,
    tokenIn: p.tokenIn.toLowerCase(),
    tokenOut: p.tokenOut.toLowerCase(),
    amountRaw: p.amountRaw,
    decimalsIn: p.decimalsIn,
    decimalsOut: p.decimalsOut,
  }
}

/** Same chain, same ordered token pair, same decimals — amount ignored. */
export function sameQuotePair(
  a: Pick<QuoteKey, 'chainId' | 'tokenIn' | 'tokenOut' | 'decimalsIn' | 'decimalsOut'>,
  b: Pick<QuoteKey, 'chainId' | 'tokenIn' | 'tokenOut' | 'decimalsIn' | 'decimalsOut'>,
): boolean {
  return (
    a.chainId === b.chainId &&
    a.tokenIn.toLowerCase() === b.tokenIn.toLowerCase() &&
    a.tokenOut.toLowerCase() === b.tokenOut.toLowerCase() &&
    a.decimalsIn === b.decimalsIn &&
    a.decimalsOut === b.decimalsOut
  )
}

/** Pair match AND same raw amount. */
export function sameQuoteKey(a: QuoteKey, b: QuoteKey): boolean {
  return sameQuotePair(a, b) && a.amountRaw === b.amountRaw
}

/**
 * Does a stored quote belong to the CURRENT selection? Fail-closed: a quote
 * with no identity (or a malformed one) never matches.
 */
export function quoteMatchesSelection(
  identity: QuoteIdentity | null | undefined,
  selection: { chainId: number; tokenIn: TokenLike | null; tokenOut: TokenLike | null },
): boolean {
  if (!identity || !selection.tokenIn || !selection.tokenOut) return false
  return sameQuotePair(identity, {
    chainId: selection.chainId,
    tokenIn: selection.tokenIn.address,
    tokenOut: selection.tokenOut.address,
    decimalsIn: selection.tokenIn.decimals,
    decimalsOut: selection.tokenOut.decimals,
  })
}
