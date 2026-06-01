import { useReadContract, useEstimateFeesPerGas } from 'wagmi'
import { chainlinkAggregatorAbi } from '@/lib/chainlink'
import { NATIVE_ETH } from '@/lib/constants'
import { getChainlinkFeed } from '@/lib/chains/chainlink-feeds'
import { useActiveChainId } from './useChainId'

interface GasCost {
  ethPrice: number | null   // ETH/USD from Chainlink
  gasPriceGwei: number | null
  /** Compute cost in ETH and USD for a given gas estimate */
  estimate: (gasUnits: number) => { eth: number; usd: number } | null
}

/**
 * Returns current ETH/USD price (Chainlink) + gas price so we can
 * display gas estimates as "~0.004 ETH ($12.50)".
 *
 * [SPRINT-9E] Chain-aware: the ETH/USD feed is resolved for the ACTIVE chain
 * (chainId 1 → CHAINLINK_ETH_USD, byte-identical; Base → the Base ETH/USD feed),
 * and both the feed read and the gas estimate target that chain. Previously the
 * mainnet feed was hardcoded, so on Base the read returned nothing → ethPrice
 * null → no gas/fee USD (the UI fell back to raw gas units).
 */
export function useEthGasCost(): GasCost {
  const chainId = useActiveChainId()
  // ETH = native token on every supported chain; NATIVE_ETH maps to the chain's
  // wrapped-native ETH/USD feed via getChainlinkFeed.
  const ethUsdFeed = getChainlinkFeed(NATIVE_ETH, chainId)

  // ETH/USD from Chainlink (per-chain feed, per-chain read)
  const { data: roundData } = useReadContract({
    address: ethUsdFeed ?? undefined,
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
    chainId,
    query: { enabled: !!ethUsdFeed },
  })

  const { data: feedDecimals } = useReadContract({
    address: ethUsdFeed ?? undefined,
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
    chainId,
    query: { enabled: !!ethUsdFeed },
  })

  // Gas price from EIP-1559 — for the active chain (Base gas on Base).
  const { data: feeData } = useEstimateFeesPerGas({ chainId })

  const ethPrice =
    roundData && feedDecimals !== undefined
      ? Number(roundData[1]) / 10 ** Number(feedDecimals)
      : null

  const gasPriceWei = feeData?.maxFeePerGas ?? null
  const gasPriceGwei = gasPriceWei ? Number(gasPriceWei) / 1e9 : null

  const estimate = (gasUnits: number) => {
    if (!ethPrice || !gasPriceWei) return null
    const costEth = (gasUnits * Number(gasPriceWei)) / 1e18
    const costUsd = costEth * ethPrice
    return { eth: costEth, usd: costUsd }
  }

  return { ethPrice, gasPriceGwei, estimate }
}
