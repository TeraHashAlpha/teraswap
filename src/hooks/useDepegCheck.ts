import { useReadContract } from 'wagmi'
import { chainlinkAggregatorAbi, getFeedStalenessSec } from '@/lib/chainlink'
import { getExchangeRatePair } from '@/lib/chains/chainlink-feeds'
import { evaluateDepeg, priceFromValidRound, type DepegCheck } from '@/lib/depeg-gate'
import { useActiveChainId } from './useChainId'

/**
 * [SPRINT-9W-oracle] cbETH depeg circuit-breaker hook — a SECOND, independent verdict alongside the
 * 9J price-impact gate, computed from the divergence between a token's MARKET feed and its
 * EXCHANGE-RATE feed (the swap-price reference is unchanged — still the market feed via
 * useChainlinkPrice).
 *
 * For whichever token in the swap pair has BOTH feeds (data-driven via getExchangeRatePair —
 * cbETH on Base today, any future such asset by registry entry), it reads both feeds, validates
 * EACH leg (9G round integrity + 9V per-feed staleness), and returns the verdict.
 *
 * Returns mode 'ok' (no-op) when:
 *  - neither token has an exchange-rate pair (the common case — non-cbETH swaps unchanged); or
 *  - EITHER feed is stale/invalid (FAIL-OPEN: a feed outage is NOT a depeg → fall back to the
 *    existing no-oracle calm warning + multi-source path; never a false hard block).
 *
 * The four useReadContract calls are always invoked (fixed hook order) and gated by `enabled` so
 * non-pair swaps issue no RPC reads.
 */
export function useDepegCheck(
  tokenInAddress: string | undefined,
  tokenOutAddress: string | undefined,
): DepegCheck {
  const chainId = useActiveChainId()
  const pair =
    (tokenInAddress ? getExchangeRatePair(tokenInAddress, chainId) : null) ??
    (tokenOutAddress ? getExchangeRatePair(tokenOutAddress, chainId) : null)
  const enabled = !!pair

  const { data: marketRound } = useReadContract({
    address: pair?.market, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData', chainId, query: { enabled },
  })
  const { data: marketDecimals } = useReadContract({
    address: pair?.market, abi: chainlinkAggregatorAbi, functionName: 'decimals', chainId, query: { enabled },
  })
  const { data: erRound } = useReadContract({
    address: pair?.exchangeRate, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData', chainId, query: { enabled },
  })
  const { data: erDecimals } = useReadContract({
    address: pair?.exchangeRate, abi: chainlinkAggregatorAbi, functionName: 'decimals', chainId, query: { enabled },
  })

  if (!pair) return { mode: 'ok', divergence: 0, symbol: '', message: null }

  const now = Math.floor(Date.now() / 1000)
  // Each leg: 9G integrity + 9V per-feed staleness (heartbeat×1.5, else the 90_000 UI global —
  // matching useChainlinkPrice), decimals applied per-leg. A failing leg → null → evaluateDepeg
  // returns 'ok' (fail-open).
  const marketPrice = priceFromValidRound(marketRound, marketDecimals, getFeedStalenessSec(pair.market, 90_000), now)
  const erPrice = priceFromValidRound(erRound, erDecimals, getFeedStalenessSec(pair.exchangeRate, 90_000), now)

  return evaluateDepeg(marketPrice, erPrice, pair.symbol)
}
