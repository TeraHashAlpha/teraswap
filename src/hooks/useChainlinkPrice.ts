import { useAccount, useReadContract } from 'wagmi'
import { getChainlinkFeed, getFeedStalenessSec, getFeedExpectation, chainlinkAggregatorAbi, evaluateDeviation, type PriceCheck } from '@/lib/chainlink'
import { hasReadFailed } from '@/lib/depeg-gate'
import { useResolvedChainId } from './useChainId'

/**
 * Hook: reads Chainlink oracle price for a token and compares with execution price.
 * Returns a PriceCheck with warning level.
 *
 * [SPRINT-9E] Chain-aware: the feed is resolved AND read on the ACTIVE chain
 * (chainId 1 → mainnet feeds, byte-identical; Base → the Base feed). Previously
 * both the lookup and the read defaulted to mainnet, so on Base the read hit a
 * mainnet feed address on the Base chain → no contract → chainlinkPrice null →
 * the platform-fee row showed no USD. Mirrors useEthGasCost's gas-USD fix.
 *
 * [FIX-PRICE-ORACLE-FAIL-CLOSED] This hook used to FAIL OPEN. A read error, a revert, or a
 * settled-but-empty response all fell into the same `!roundData` branch as "not loaded yet" and
 * returned `level:'none', oracleUnavailable:false` — a verdict indistinguishable from a healthy
 * first render. Both client gates read that as "nothing to worry about", so a feed outage silently
 * disabled BOTH the Chainlink deviation gate AND the >$10k unpriceable gate for every feed-covered
 * pair. It now fails CLOSED. Three states for a configured feed, each meaning exactly one thing:
 *
 *  - in-flight  — the first read is genuinely still loading, with no failure on record. Neutral and
 *                 frictionless, exactly as before (a normal first render is not an error).
 *  - UNREADABLE — we tried and could not get a usable round: read error, revert, settled-but-empty,
 *                 a read already in its retry sequence, or an unresolved chain. Blocks, with copy
 *                 that says the feed could not be READ — never that the token has no feed.
 *  - loaded     — the pre-existing integrity / staleness / deviation ladder, unchanged.
 *
 * Why UNREADABLE sets three flags rather than one (this is the load-bearing part):
 *  - `oracleUnavailable: true`     → engages the tiered >$10k unpriceable gate in SwapBox.
 *  - `oracleIntegrityFailed: true` → engages the deviation gate as a HARD block. This is what makes
 *    the fix bite at EVERY trade size: `oracleUnavailable` alone would leave a $50 swap passing,
 *    since the tiered gate only blocks above its USD threshold. Note `evaluatePriceGate` had to be
 *    reordered to test integrity BEFORE unavailability — with the original ordering, setting
 *    `oracleUnavailable` would have returned 'ok' and made sub-threshold swaps WEAKER than before
 *    this fix, not stronger.
 *  - `oracleReadFailed: true`      → distinguishes "the feed exists but we could not read it" from
 *    "this token has no feed at all". Both are `oracleUnavailable`, but the existing no-feed copy
 *    ("This token has no Chainlink price feed") is simply false for an outage, and telling a user
 *    that is its own kind of lie — the same distinction the depeg gate draws between "depegged" and
 *    "could not check".
 *
 * [ADR-018] The read above assumed the address WAS the pair the config claims — nothing asked the
 * feed. A sibling verification pass found 7 mainnet feeds whose description() contradicts their
 * config key; 6 fail loudly (no code / dead proxy / wrong denomination, all already caught above as
 * UNREADABLE or an invalid/stale round) but WBTC/USD silently reads the BTC/USD index feed and PASSES
 * every check above, because decimals happen to match (8) and the round is genuinely fresh and valid.
 * This hook now also reads description() and compares BOTH description and decimals against
 * FEED_EXPECTATIONS before trusting `answer` — a mismatch on either is folded into the SAME
 * oracle-integrity-failed branch as the stale/invalid-round checks below (never a soft warning).
 * NOTE: this hook still has no composed-feed capability (cbETH-style base×quote) — that gap
 * pre-dates and is untouched by this change; composed tokens remain a "no feed" (`oracleUnavailable`)
 * verdict here exactly as before.
 */

/** Neutral, frictionless verdict — a first render or a case with nothing to guard. */
const NEUTRAL = (executionPriceUsd: number | null): PriceCheck => ({
  chainlinkPrice: null,
  executionPrice: executionPriceUsd,
  deviation: 0,
  level: 'none',
  message: null,
  oracleUnavailable: false,
})

/**
 * [FIX-PRICE-ORACLE-FAIL-CLOSED] A feed IS configured, but no usable reading came back. Blocks via
 * BOTH gates (see the header for why all three flags are required).
 */
const UNREADABLE = (executionPriceUsd: number | null, message: string): PriceCheck => ({
  chainlinkPrice: null,
  executionPrice: executionPriceUsd,
  deviation: 0,
  level: 'warn',
  message,
  oracleUnavailable: true,
  oracleIntegrityFailed: true,
  oracleReadFailed: true,
})

export function useChainlinkPrice(
  tokenAddress: string | undefined,
  executionPriceUsd: number | null,
): PriceCheck {
  // [FIX-PRICE-ORACLE-FAIL-CLOSED] No `?? DEFAULT_CHAIN_ID` fallback: this is an oracle read, and a
  // gate that silently assumes mainnet during a transient resolves MAINNET's feed registry for a
  // token the user holds on another chain — then reports a confident verdict about the wrong feed
  // (or a confident "no feed" when one exists on the real chain). A gate must know which chain it
  // guards. Same reasoning, and the same helper, as useDepegCheck.
  const chainId = useResolvedChainId()
  const { isConnected } = useAccount()

  // Only resolve a feed once the chain is known — getChainlinkFeed defaults its chainId parameter
  // to mainnet, so passing an unresolved chain through would silently reintroduce the mainnet
  // assumption this hook just removed.
  const feedAddress = chainId != null && tokenAddress ? getChainlinkFeed(tokenAddress, chainId) : null
  const enabled = !!feedAddress

  // [FIX-PRICE-ORACLE-FAIL-CLOSED] refetchInterval mirrors useDepegCheck and the sibling read hooks.
  // It is not cosmetic: a query that settles into `error` is not retried by TanStack on its own, so
  // without a poll an UNREADABLE verdict would latch for the whole session view. Only fires when a
  // feed is actually configured, so no-feed tokens still issue zero reads.
  const query = { enabled, refetchInterval: enabled ? 30_000 : undefined }

  const round = useReadContract({
    address: feedAddress!,
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
    chainId,
    query,
  })

  const dec = useReadContract({
    address: feedAddress!,
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
    chainId,
    query,
  })

  // [ADR-018] Self-identification: the feed's own description() must be checked before its answer
  // is trusted, same as decimals() above.
  const desc = useReadContract({
    address: feedAddress!,
    abi: chainlinkAggregatorAbi,
    functionName: 'description',
    chainId,
    query,
  })

  // [FIX-PRICE-ORACLE-FAIL-CLOSED] Chain unresolved. Disconnected is NOT a failure — there is no
  // swap to guard and no chain to guard it on, so stay neutral (identical to the frictionless first
  // render this hook has always had for a disconnected visitor). CONNECTED with an unresolvable
  // chain (mid-switch, or an unsupported chain) is exactly the transient where the old
  // fallback-to-mainnet produced a confident verdict about the wrong registry, so that blocks.
  if (chainId == null) {
    return isConnected
      ? UNREADABLE(executionPriceUsd, 'Could not determine which network to verify this price on. Price not verified.')
      : NEUTRAL(executionPriceUsd)
  }

  // No feed available → flag oracle as unavailable and warn user
  // [SECURITY] Previously returned level: 'none' with no visible warning.
  // After the $50M aEthUSDT→aEthAAVE incident, unverified tokens MUST show a warning.
  // NOTE: this is the "no feed configured" case — a permanent property of the token, distinct from
  // the UNREADABLE case below (a configured feed we failed to read). oracleReadFailed stays unset.
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

  const roundData = round.data
  const feedDecimals = dec.data
  const feedDescription = desc.data

  // [FIX-PRICE-ORACLE-FAIL-CLOSED] A read we could not complete means the price is UNVERIFIED. This
  // is the branch the whole fix turns on: it previously collapsed into the "not loaded yet" case and
  // returned a healthy-looking verdict.
  //
  // The test is "do we HAVE a usable round?", deliberately NOT "did the last fetch error?". TanStack
  // RETAINS the last successful `data` when a *refetch* fails, so with the 30s poll added above an
  // `isError` short-circuit placed ahead of this check would hard-block the entire app on any
  // transient RPC blip — while holding a round the oracle itself timestamps as fresh, and which the
  // staleness ladder below would happily verify. (decimals()/description() are immutable and still
  // re-polled, so that variant blocked on values we already hold and that can never change.) Failing
  // closed on "no usable data" and letting the per-feed staleness ceiling judge retained data is both
  // safer and self-correcting: if the outage outlives the feed's heartbeat×1.5 window, `ageSeconds`
  // grows past it and the integrity branch below blocks anyway.
  if (!roundData || feedDecimals === undefined || feedDescription === undefined) {
    // The burden of proof is INVERTED here: neutral is granted ONLY to a read with no failure
    // history. `isLoading` alone is not a safe test — TanStack keeps it true across an entire retry
    // sequence, and resets `failureCount` to 0 on every new fetch, so a sustained outage would keep
    // re-presenting as a pristine first render once per poll. That was M-01; `hasReadFailed`
    // combines failureCount (the in-retry window) with errorUpdateCount (the post-poll window, which
    // the library never resets) precisely so that hole stays shut here too.
    const anyFailure = round.isError || dec.isError || desc.isError || hasReadFailed(round) || hasReadFailed(dec) || hasReadFailed(desc)
    const inFlight = (round.isLoading || dec.isLoading || desc.isLoading) && !anyFailure
    return inFlight
      ? NEUTRAL(executionPriceUsd)
      : UNREADABLE(executionPriceUsd, 'Chainlink price feed could not be read. Price not verified.')
  }

  // [ADR-018 invariant (c)] Self-identification: the feed's own description()/decimals() must match
  // what FEED_EXPECTATIONS declares for this address BEFORE the answer below is trusted. This is
  // checked first — ahead of even the answer<=0 guard — because a mismatch means the feed cannot be
  // trusted regardless of what its round data says. A feed with no declared expectation at all (should
  // be unreachable given the ADR-018 import-time completeness assert, but checked defensively) fails
  // the same way. This is the check that catches WBTC/USD silently reading the BTC/USD index feed:
  // its round data is genuinely fresh and valid, so every guard below it would otherwise pass.
  const expectation = getFeedExpectation(feedAddress)
  if (!expectation || feedDescription !== expectation.description || Number(feedDecimals) !== expectation.decimals) {
    return {
      chainlinkPrice: null,
      executionPrice: executionPriceUsd,
      deviation: 0,
      level: 'warn',
      message: 'Chainlink feed identity does not match the configured pair. Price not verified.',
      oracleUnavailable: false,
      oracleIntegrityFailed: true,
    }
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
