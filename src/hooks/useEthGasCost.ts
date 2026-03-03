import { useReadContract, useEstimateFeesPerGas } from 'wagmi'
import { chainlinkAggregatorAbi } from '@/lib/chainlink'
import { CHAINLINK_ETH_USD } from '@/lib/constants'

interface GasCost {
  ethPrice: number | null   // ETH/USD from Chainlink
  gasPriceGwei: number | null
  /** Compute cost in ETH and USD for a given gas estimate */
  estimate: (gasUnits: number) => { eth: number; usd: number } | null
}

/**
 * Returns current ETH/USD price (Chainlink) + gas price so we can
 * display gas estimates as "~0.004 ETH ($12.50)".
 */
export function useEthGasCost(): GasCost {
  // ETH/USD from Chainlink
  const { data: roundData } = useReadContract({
    address: CHAINLINK_ETH_USD,
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
  })

  const { data: feedDecimals } = useReadContract({
    address: CHAINLINK_ETH_USD,
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
  })

  // Gas price from EIP-1559
  const { data: feeData } = useEstimateFeesPerGas()

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
