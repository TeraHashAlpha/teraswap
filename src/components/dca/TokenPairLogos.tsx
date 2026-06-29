'use client'

/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] TokenPairLogos — the spend→buy pair with brand-consistent logos
 * (reuses the shared <TokenLogo> fallback chain) keyed to the order's chain so Base logos resolve.
 */

import TokenLogo from '@/components/TokenLogo'
import { findChainToken } from '@/lib/chains/tokens'
import type { Token } from '@/lib/tokens'

function tokenFor(address: string, symbol: string, chainId: number): Pick<Token, 'address' | 'symbol' | 'logoURI' | 'chainId'> {
  const catalog = findChainToken(address, chainId)
  if (catalog) return catalog
  return { address: address as `0x${string}`, symbol, logoURI: '', chainId }
}

interface Props {
  tokenInAddress: string
  tokenInSymbol: string
  tokenOutAddress: string
  tokenOutSymbol: string
  chainId: number
  size?: number
}

export default function TokenPairLogos({
  tokenInAddress, tokenInSymbol, tokenOutAddress, tokenOutSymbol, chainId, size = 22,
}: Props) {
  return (
    <span className="flex items-center gap-1.5" data-testid="token-pair">
      <TokenLogo token={tokenFor(tokenInAddress, tokenInSymbol, chainId)} size={size} />
      <span className="text-[15px] font-semibold text-cream">{tokenInSymbol}</span>
      <span className="text-cream-35" aria-hidden="true">→</span>
      <TokenLogo token={tokenFor(tokenOutAddress, tokenOutSymbol, chainId)} size={size} />
      <span className="text-[15px] font-semibold text-cream">{tokenOutSymbol}</span>
    </span>
  )
}
