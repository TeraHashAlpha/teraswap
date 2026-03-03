import { useReadContract } from 'wagmi'
import { getChainlinkFeed, chainlinkAggregatorAbi, evaluateDeviation, type PriceCheck } from '@/lib/chainlink'

/**
 * Hook: reads Chainlink oracle price for a token and compares with execution price.
 * Returns a PriceCheck with warning level.
 */
export function useChainlinkPrice(
  tokenAddress: string | undefined,
  executionPriceUsd: number | null,
): PriceCheck {
  const feedAddress = tokenAddress ? getChainlinkFeed(tokenAddress) : null

  const { data: roundData } = useReadContract({
    address: feedAddress!,
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
    query: { enabled: !!feedAddress },
  })

  const { data: feedDecimals } = useReadContract({
    address: feedAddress!,
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
    query: { enabled: !!feedAddress },
  })

  // No feed available → flag oracle as unavailable for this token
  if (!feedAddress) {
    return { chainlinkPrice: null, executionPrice: executionPriceUsd, deviation: 0, level: 'none', message: null, oracleUnavailable: !!tokenAddress }
  }

  // Feed exists but data not loaded yet
  if (!roundData || feedDecimals === undefined) {
    return { chainlinkPrice: null, executionPrice: executionPriceUsd, deviation: 0, level: 'none', message: null, oracleUnavailable: false }
  }

  // Parse Chainlink answer
  const [roundId, answer, , updatedAt, answeredInRound] = roundData
  const chainlinkPrice = Number(answer) / 10 ** Number(feedDecimals)

  // Security: invalid price
  if (Number(answer) <= 0) {
    return { chainlinkPrice: null, executionPrice: executionPriceUsd, deviation: 0, level: 'warn', message: 'Chainlink oracle returned invalid price.', oracleUnavailable: false }
  }

  // Security: answeredInRound must equal roundId (data from current round)
  if (answeredInRound < roundId) {
    return {
      chainlinkPrice,
      executionPrice: executionPriceUsd,
      deviation: 0,
      level: 'warn',
      message: 'Chainlink oracle data is stale (answeredInRound < roundId). Verify price manually.',
      oracleUnavailable: false,
    }
  }

  // Check staleness (>1 hour = stale)
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt)
  if (ageSeconds > 3600) {
    return {
      chainlinkPrice,
      executionPrice: executionPriceUsd,
      deviation: 0,
      level: 'warn',
      message: `Chainlink oracle data outdated (${Math.floor(ageSeconds / 60)} min old). Verify price manually.`,
      oracleUnavailable: false,
    }
  }

  // No execution price to compare → just return chainlink price
  if (!executionPriceUsd) {
    return { chainlinkPrice, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false }
  }

  return evaluateDeviation(chainlinkPrice, executionPriceUsd)
}
