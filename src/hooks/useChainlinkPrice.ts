import { useAccount, useReadContract } from 'wagmi'
import {
  chainlinkAggregatorAbi,
  evaluateDeviation,
  evaluateFeedLeg,
  composeFeedLegs,
  type FeedLegFailure,
  type FeedLegVerdict,
  type PriceCheck,
} from '@/lib/chainlink'
import { resolveFeed, type FeedLeg } from '@/lib/chains/chainlink-feeds'
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
 *
 * [FIX-HOOK-COMPOSED-FEEDS] COMPOSED-FEED SUPPORT — closing a fail-OPEN regression.
 *
 * This hook used to resolve feeds with a bare `getChainlinkFeed` (direct map only). When
 * FIX-MAINNET-FEED-REMEDIATION converted mainnet GRT/LDO/SHIB/WBTC to composed entries — and
 * therefore removed them from the direct map — this hook stopped finding them at all and fell into
 * the "no feed configured" branch: `oracleUnavailable: true` WITHOUT `oracleIntegrityFailed`. That is
 * the one combination `evaluatePriceGate` deliberately WAIVES (mode 'ok'), so four mainnet tokens
 * became swappable with zero Chainlink validation at any size, and WBTC in particular went from a
 * 0–3% blind band to no oracle check whatsoever. A fix that narrows one hole and opens a wider one
 * is a net regression, which is what this closes.
 *
 * The hook now resolves through `resolveFeed` — the SAME resolver the server/DCA path uses — and
 * reads both legs of a composition (3 contract reads per leg, leg B disabled for a single feed so
 * the Rules of Hooks are satisfied with a fixed call count). Per-leg identity, integrity and
 * staleness, plus the composition itself, all run through the SHARED pure helpers in
 * `@/lib/chainlink` (evaluateFeedLeg / composeFeedLegs) rather than a second copy of the rules here.
 *
 * A leg that is READ but fails identity/integrity/staleness yields `oracleIntegrityFailed: true` with
 * `oracleUnavailable: false` — a hard block at every trade size, never the waived branch. Only a
 * token with genuinely NO configured feed (resolveFeed → null) is `oracleUnavailable`.
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

/**
 * [FIX-HOOK-COMPOSED-FEEDS] A leg was READ but did not survive validation. Always a hard block
 * (`oracleIntegrityFailed`) and deliberately NOT `oracleUnavailable` — the feed exists and we read
 * it, so this must never land in the branch `evaluatePriceGate` waives.
 */
const LEG_FAILED = (
  executionPriceUsd: number | null,
  verdict: Extract<FeedLegVerdict, { ok: false }>,
  chainlinkPrice: number | null,
): PriceCheck => ({
  chainlinkPrice,
  executionPrice: executionPriceUsd,
  deviation: 0,
  level: 'warn',
  message: LEG_FAILURE_COPY[verdict.reason](verdict.ageSeconds),
  oracleUnavailable: false,
  oracleIntegrityFailed: true,
})

/** Per-reason copy. Wording preserved from the pre-composition branches so existing UX is unchanged. */
const LEG_FAILURE_COPY: Record<FeedLegFailure, (ageSeconds: number) => string> = {
  identity: () => 'Chainlink feed identity does not match the configured pair. Price not verified.',
  'invalid-answer': () => 'Chainlink oracle returned invalid price.',
  'stale-round': () => 'Chainlink oracle data is stale (answeredInRound < roundId). Verify price manually.',
  'incomplete-round': () => 'Chainlink oracle round is incomplete. Verify price manually.',
  outdated: (age) => `Chainlink oracle data outdated (${Math.floor(age / 3600)}h old). Verify price manually.`,
}

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

  // [FIX-HOOK-COMPOSED-FEEDS] Resolve through the SAME resolver the server path uses, so a token is
  // never "configured" for one path and invisible to the other. Only once the chain is known —
  // resolveFeed defaults its chainId parameter to mainnet, so passing an unresolved chain through
  // would silently reintroduce the mainnet assumption this hook removed.
  const resolved = chainId != null && tokenAddress ? resolveFeed(tokenAddress, chainId) : null

  // Leg A is the single feed or the composition's base; leg B exists only for a composition. Both
  // read slots are ALWAYS declared (Rules of Hooks: fixed call count) — leg B is simply disabled
  // when there is nothing to read.
  const legA: FeedLeg | null = resolved
    ? (resolved.kind === 'single' ? resolved.leg : resolved.base)
    : null
  const legB: FeedLeg | null = resolved && resolved.kind === 'composed' ? resolved.quote : null

  // [FIX-PRICE-ORACLE-FAIL-CLOSED] refetchInterval mirrors useDepegCheck and the sibling read hooks.
  // It is not cosmetic: a query that settles into `error` is not retried by TanStack on its own, so
  // without a poll an UNREADABLE verdict would latch for the whole session view. Only fires when a
  // feed is actually configured, so no-feed tokens still issue zero reads.
  const queryA = { enabled: !!legA, refetchInterval: legA ? 30_000 : undefined }
  const queryB = { enabled: !!legB, refetchInterval: legB ? 30_000 : undefined }

  const round = useReadContract({
    address: legA?.address as `0x${string}`,
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
    chainId,
    query: queryA,
  })

  const dec = useReadContract({
    address: legA?.address as `0x${string}`,
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
    chainId,
    query: queryA,
  })

  // [ADR-018] Self-identification: the feed's own description() must be checked before its answer
  // is trusted, same as decimals() above.
  const desc = useReadContract({
    address: legA?.address as `0x${string}`,
    abi: chainlinkAggregatorAbi,
    functionName: 'description',
    chainId,
    query: queryA,
  })

  // [FIX-HOOK-COMPOSED-FEEDS] Leg B — the composition's quote leg (e.g. ETH/USD for GRT/ETH, or
  // BTC/USD for WBTC/BTC). Disabled entirely for a single feed, so a direct-feed token issues the
  // exact same three reads it always did.
  const roundB = useReadContract({
    address: legB?.address as `0x${string}`,
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
    chainId,
    query: queryB,
  })

  const decB = useReadContract({
    address: legB?.address as `0x${string}`,
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
    chainId,
    query: queryB,
  })

  const descB = useReadContract({
    address: legB?.address as `0x${string}`,
    abi: chainlinkAggregatorAbi,
    functionName: 'description',
    chainId,
    query: queryB,
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
  // [FIX-HOOK-COMPOSED-FEEDS] Keyed on resolveFeed, so a COMPOSED token can no longer land here:
  // this branch is now reachable only for a token with genuinely no configured feed of either shape.
  if (!legA) {
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
  // [FIX-HOOK-COMPOSED-FEEDS] Readiness is judged across EVERY leg in play. A composition with one
  // leg loaded and the other still missing is NOT priceable — treating it as ready would be exactly
  // the partial pricing ADR-018 invariant (d) forbids.
  const legBPending = !!legB && (roundB.data === undefined || decB.data === undefined || descB.data === undefined)
  if (!roundData || feedDecimals === undefined || feedDescription === undefined || legBPending) {
    // The burden of proof is INVERTED here: neutral is granted ONLY to a read with no failure
    // history. `isLoading` alone is not a safe test — TanStack keeps it true across an entire retry
    // sequence, and resets `failureCount` to 0 on every new fetch, so a sustained outage would keep
    // re-presenting as a pristine first render once per poll. That was M-01; `hasReadFailed`
    // combines failureCount (the in-retry window) with errorUpdateCount (the post-poll window, which
    // the library never resets) precisely so that hole stays shut here too.
    const reads = legB ? [round, dec, desc, roundB, decB, descB] : [round, dec, desc]
    const anyFailure = reads.some((r) => r.isError || hasReadFailed(r))
    const inFlight = reads.some((r) => r.isLoading) && !anyFailure
    return inFlight
      ? NEUTRAL(executionPriceUsd)
      : UNREADABLE(executionPriceUsd, 'Chainlink price feed could not be read. Price not verified.')
  }

  // [ADR-018 / FIX-HOOK-COMPOSED-FEEDS] Validate leg A through the SHARED evaluator: identity
  // (description + decimals vs FEED_EXPECTATIONS) → round integrity → per-feed staleness, in that
  // order. Identity is checked FIRST — ahead of even the answer<=0 guard — because a mismatch means
  // the feed cannot be trusted regardless of what its round data says. This is the check that catches
  // a feed whose round is genuinely fresh and valid but which is simply the WRONG feed.
  // The 90_000 (25h) global fallback is this hook's pre-existing one, preserved.
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = roundData
  const verdictA = evaluateFeedLeg({
    feed: legA.address,
    description: feedDescription as string,
    decimals: Number(feedDecimals),
    roundId, answer, startedAt, updatedAt, answeredInRound,
    globalStalenessSec: 90_000,
  })
  if (!verdictA.ok) {
    // Surface a price alongside the block only when the leg's own numbers were internally coherent
    // (i.e. it failed on freshness/round-sequence, not on identity or a non-positive answer) — and
    // never for a composition, where one leg's price is not a token price. Mirrors the pre-existing
    // per-branch behaviour of showing chainlinkPrice for stale/outdated but null for identity/invalid.
    const showPrice =
      !legB && (verdictA.reason === 'stale-round' || verdictA.reason === 'outdated' || verdictA.reason === 'incomplete-round')
    return LEG_FAILED(executionPriceUsd, verdictA, showPrice ? Number(answer) / 10 ** Number(feedDecimals) : null)
  }

  // Single feed → leg A's price IS the token price. Composed → validate leg B independently and
  // multiply. Either leg failing fails the WHOLE read (no partial pricing).
  let chainlinkPrice = verdictA.price
  if (legB) {
    const [rIdB, ansB, startB, updB, airB] = roundB.data as readonly [bigint, bigint, bigint, bigint, bigint]
    const verdictB = evaluateFeedLeg({
      feed: legB.address,
      description: descB.data as string,
      decimals: Number(decB.data),
      roundId: rIdB, answer: ansB, startedAt: startB, updatedAt: updB, answeredInRound: airB,
      globalStalenessSec: 90_000,
    })
    if (!verdictB.ok) return LEG_FAILED(executionPriceUsd, verdictB, null)
    // [ADR-018 invariant (d)] Shared composition — price = base × quote, freshness = the older leg.
    chainlinkPrice = composeFeedLegs(verdictA, verdictB).price
  }

  // No execution price to compare → just return chainlink price
  if (!executionPriceUsd) {
    return { chainlinkPrice, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false }
  }

  return evaluateDeviation(chainlinkPrice, executionPriceUsd)
}
