'use client'

import { useCallback, useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { useDepegCheck } from '@/hooks/useDepegCheck'
import type { MetaQuoteResult } from '@/lib/adapters/types'
import type { PriceCheck } from '@/lib/chainlink'
import type { SwapPriceLeg, SwapPriceTierResponse } from '@/lib/swap-price-tier'
import { estimateSwapUsd } from '@/lib/swap-usd-estimate'
import type { Token } from '@/lib/tokens'
import { safeBigInt } from '@/lib/utils'
import { computeGates, type SwapGates } from './gates'

/** SwapBox's private `legReferenceUsd`: a `priced` / `single-source` leg has a USD reference; `unpriced` / unknown has none. */
function legReferenceUsd(leg: SwapPriceLeg | undefined): number | null {
  if (!leg || leg.tier === 'unpriced' || typeof leg.usd !== 'number') return null
  return leg.usd
}

export interface UseSwapGatesArgs {
  tokenIn: Token | null
  tokenOut: Token | null
  amountIn: string
  /** The amount-current, MEV-selected quote (v1's `meta`). */
  meta: MetaQuoteResult | null
  quoteDecimalsOut: number | null
  activeChainId: number
  /** `evaluatePairOracle(...)` — computed by the caller (the card already needs it for the quote panel). */
  pairCheck: PriceCheck
  tokenInChainlinkPrice: number | null
  tokenOutChainlinkPrice: number | null
  priceTier: SwapPriceTierResponse | null | undefined
}

export interface SwapGateState extends SwapGates {
  estimatedSwapUsd: number
  depegCheck: ReturnType<typeof useDepegCheck>
  /** v1's `setAcceptedDeviation(checked ? pairCheck.deviation : null)` */
  setPriceImpactAccepted: (checked: boolean) => void
  /** v1's `setAcceptedDepeg(checked ? depegCheck.divergence : null)` */
  setDepegAccepted: (checked: boolean) => void
}

/**
 * SwapBox's gate wiring. v1 clears both consents in the handlers that change the trade (amount edit, ⇅, token pick, chain switch);
 * here the card derives instead of resetting, so the consent is stored WITH the trade it was given for and simply stops applying when
 * that key changes — the same lifetime, with no render in which a stale tick can survive.
 */
export function useSwapGates(i: UseSwapGatesArgs): SwapGateState {
  const depegCheck = useDepegCheck(i.tokenIn?.address, i.tokenOut?.address)
  const tradeKey = `${i.activeChainId}:${i.tokenIn?.address ?? ''}:${i.tokenOut?.address ?? ''}:${i.amountIn}`
  const [accepted, setAccepted] = useState<{ key: string; deviation: number | null; depeg: number | null }>({ key: tradeKey, deviation: null, depeg: null })
  const live = accepted.key === tradeKey ? accepted : { key: tradeKey, deviation: null, depeg: null }

  const { meta, tokenIn, tokenOut, amountIn, quoteDecimalsOut, activeChainId, tokenInChainlinkPrice, tokenOutChainlinkPrice, priceTier } = i
  // [TM-P2 / feat/swap-price-tiers D2] trade value = max(inputUsd, outputUsd) via v1's pure helper; a priced leg's quorum price feeds it.
  const estimatedSwapUsd = useMemo(() => {
    if (!tokenIn || !amountIn || Number(amountIn) <= 0) return 0
    const outBig = meta?.best ? safeBigInt(meta.best.toAmount) : null
    const amountOut = outBig !== null && tokenOut && quoteDecimalsOut !== null ? Number(formatUnits(outBig, quoteDecimalsOut)) : null
    return estimateSwapUsd({
      tokenIn,
      tokenOut,
      amountIn: Number(amountIn),
      amountOut,
      chainlinkPriceIn: tokenInChainlinkPrice,
      chainlinkPriceOut: tokenOutChainlinkPrice,
      referencePriceIn: legReferenceUsd(priceTier?.legs.in),
      referencePriceOut: legReferenceUsd(priceTier?.legs.out),
      chainId: activeChainId,
    }).usd
  }, [tokenIn, tokenOut, amountIn, meta, quoteDecimalsOut, tokenInChainlinkPrice, tokenOutChainlinkPrice, priceTier, activeChainId])

  const gates = computeGates({ pairCheck: i.pairCheck, depegCheck, acceptedDeviation: live.deviation, acceptedDepeg: live.depeg, estimatedSwapUsd })

  // The other consent is carried over only when it was given for this same trade.
  const setPriceImpactAccepted = useCallback(
    (checked: boolean) => setAccepted((p) => ({ key: tradeKey, deviation: checked ? i.pairCheck.deviation : null, depeg: p.key === tradeKey ? p.depeg : null })),
    [tradeKey, i.pairCheck.deviation],
  )
  const setDepegAccepted = useCallback(
    (checked: boolean) => setAccepted((p) => ({ key: tradeKey, deviation: p.key === tradeKey ? p.deviation : null, depeg: checked ? depegCheck.divergence : null })),
    [tradeKey, depegCheck.divergence],
  )

  return { ...gates, estimatedSwapUsd, depegCheck, setPriceImpactAccepted, setDepegAccepted }
}
