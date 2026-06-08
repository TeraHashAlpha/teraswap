import { useReadContract } from 'wagmi'
import { getChainlinkFeed, getFeedStalenessSec, chainlinkAggregatorAbi, evaluateDeviation, type PriceCheck } from '@/lib/chainlink'
import { useActiveChainId } from './useChainId'

/**
 * Hook: reads Chainlink oracle price for a token and compares with execution price.
 * Returns a PriceCheck with warning level.
 *
 * [SPRINT-9E] Chain-aware: the feed is resolved AND read on the ACTIVE chain
 * (chainId 1 → mainnet feeds, byte-identical; Base → the Base feed). Previously
 * both the lookup and the read defaulted to mainnet, so on Base the read hit a
 * mainnet feed address on the Base chain → no contract → chainlinkPrice null →
 * the platform-fee row showed no USD. Mirrors useEthGasCost's gas-USD fix.
 */
export function useChainlinkPrice(
  tokenAddress: string | undefined,
  executionPriceUsd: number | null,
): PriceCheck {
  const chainId = useActiveChainId()
  const feedAddress = tokenAddress ? getChainlinkFeed(tokenAddress, chainId) : null

  const { data: roundData } = useReadContract({
    address: feedAddress!,
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
    chainId,
    query: { enabled: !!feedAddress },
  })

  const { data: feedDecimals } = useReadContract({
    address: feedAddress!,
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
    chainId,
    query: { enabled: !!feedAddress },
  })

  // No feed available → flag oracle as unavailable and warn user
  // [SECURITY] Previously returned level: 'none' with no visible warning.
  // After the $50M aEthUSDT→aEthAAVE incident, unverified tokens MUST show a warning.
  if (!feedAddress) {
    const isReal = !!tokenAddress
    return {
      chainlinkPrice: null,
      executionPrice: executionPriceUsd,
      deviation: 0,
      level: isReal ? 'warn' : 'none',
      message: isReal ? 'No Chainlink oracle available — price cannot be independently verified. Proceed with caution.' : null,
      oracleUnavailable: isReal,
    }
  }

  // Feed exists but data not loaded yet
  if (!roundData || feedDecimals === undefined) {
    return { chainlinkPrice: null, executionPrice: executionPriceUsd, deviation: 0, level: 'none', message: null, oracleUnavailable: false }
  }

  // Parse Chainlink answer
  const [roundId, answer, , updatedAt, answeredInRound] = roundData
  const chainlinkPrice = Number(answer) / 10 ** Number(feedDecimals)

  // Security: invalid price
  // [SPRINT-9J J1] oracleIntegrityFailed → genuine oracle-safety event (hard block).
  if (Number(answer) <= 0) {
    return { chainlinkPrice: null, executionPrice: executionPriceUsd, deviation: 0, level: 'warn', message: 'Chainlink oracle returned invalid price.', oracleUnavailable: false, oracleIntegrityFailed: true }
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
      oracleIntegrityFailed: true,
    }
  }

  // [SPRINT-9V V1] Per-feed staleness — heartbeat×1.5 for a feed with a known heartbeat (shared with
  // the raw gate so both AGREE), else the 90_000 (25h) global this hook used before (mainnet
  // byte-identical; unknown feeds fail-conservative). The 9G round-integrity checks above are unchanged.
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt)
  if (ageSeconds > getFeedStalenessSec(feedAddress, 90_000)) {
    return {
      chainlinkPrice,
      executionPrice: executionPriceUsd,
      deviation: 0,
      level: 'warn',
      message: `Chainlink oracle data outdated (${Math.floor(ageSeconds / 3600)}h old). Verify price manually.`,
      oracleUnavailable: false,
      oracleIntegrityFailed: true,
    }
  }

  // No execution price to compare → just return chainlink price
  if (!executionPriceUsd) {
    return { chainlinkPrice, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false }
  }

  return evaluateDeviation(chainlinkPrice, executionPriceUsd)
}
