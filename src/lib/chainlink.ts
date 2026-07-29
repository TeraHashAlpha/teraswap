import { encodeFunctionData, decodeFunctionResult } from 'viem'
import {
  PRICE_DEVIATION_WARN,
  PRICE_DEVIATION_BLOCK,
  CHAINLINK_MAX_STALENESS_SEC,
} from './constants'
import { getChainlinkFeed, getFeedStalenessSec, getFeedExpectation, resolveFeed } from './chains/chainlink-feeds'
import { isSequencerUp } from './chains/sequencer-check'
import { DEFAULT_CHAIN_ID } from './chains/registry'
import { getPublicClientForChain } from './chains/clients'
import { getRpcUrlForChain } from './adapters/shared'

// [P218] getChainlinkFeed moved to the per-chain registry; re-export so
// existing `import { getChainlinkFeed } from '@/lib/chainlink'` keeps working.
// [SPRINT-9V V1] getFeedStalenessSec likewise re-exported for the UI hook.
// [ADR-018] getFeedExpectation re-exported for useChainlinkPrice.ts's identity check.
export { getChainlinkFeed, getFeedStalenessSec, getFeedExpectation } from './chains/chainlink-feeds'

// ── Chainlink AggregatorV3 ABI (minimal) ─────────────────
export const chainlinkAggregatorAbi = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '_roundId', type: 'uint80' }],
    name: 'getRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  // [ADR-018] Self-identification: every feed proxy exposes its own pair string. Read and compared
  // against FEED_EXPECTATIONS before any answer from that feed is trusted.
  {
    inputs: [],
    name: 'description',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// ── Types ────────────────────────────────────────────────
export type PriceWarningLevel = 'none' | 'warn' | 'danger'

export interface PriceCheck {
  chainlinkPrice: number | null  // preço USD do Chainlink
  executionPrice: number | null  // preço implícito do swap
  deviation: number              // % de desvio (0.02 = 2%)
  level: PriceWarningLevel
  message: string | null
  oracleUnavailable: boolean     // true when no usable Chainlink price is available for this pair
  // [FIX-PRICE-ORACLE-FAIL-CLOSED] true when a feed IS configured but could not be READ (RPC error,
  // revert, no usable round, unresolved chain) — as opposed to a token that simply has no feed.
  // Both set oracleUnavailable; only this one means "the oracle exists and we failed to reach it",
  // which the UI must say instead of the (false) "this token has no Chainlink price feed".
  oracleReadFailed?: boolean
  // [SPRINT-9J J1] true when the deviation/warn signal is an ORACLE-INTEGRITY
  // failure (stale round, answeredInRound<roundId, answer<=0) rather than a
  // price-impact deviation. Integrity failures are a genuine oracle-safety
  // event → hard block; a deviation on a healthy oracle is price impact →
  // informed consent. See evaluatePriceGate in ./price-gate.
  oracleIntegrityFailed?: boolean
  // [SPRINT-9S S2] Tokens in the pair that lack a Chainlink feed — populated by
  // evaluatePairOracle so the warning can name them. Undefined on single-token checks.
  oracleMissingSymbols?: string[]
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Evaluate price deviation between Chainlink oracle and swap execution price.
 */
export function evaluateDeviation(
  chainlinkPrice: number,
  executionPrice: number,
): PriceCheck {
  if (chainlinkPrice <= 0 || executionPrice <= 0) {
    return { chainlinkPrice, executionPrice, deviation: 0, level: 'none', message: null, oracleUnavailable: false }
  }

  const deviation = Math.abs(executionPrice - chainlinkPrice) / chainlinkPrice

  if (deviation >= PRICE_DEVIATION_BLOCK) {
    return {
      chainlinkPrice,
      executionPrice,
      deviation,
      level: 'danger',
      message: `Warning: this swap price deviates ${(deviation * 100).toFixed(1)}% from market price (Chainlink). Possible price manipulation or low liquidity.`,
      oracleUnavailable: false,
    }
  }

  if (deviation >= PRICE_DEVIATION_WARN) {
    return {
      chainlinkPrice,
      executionPrice,
      deviation,
      level: 'warn',
      message: `Price deviates ${(deviation * 100).toFixed(1)}% from Chainlink oracle. Make sure you're comfortable with this deviation.`,
      oracleUnavailable: false,
    }
  }

  return { chainlinkPrice, executionPrice, deviation, level: 'none', message: null, oracleUnavailable: false }
}

/**
 * [SPRINT-9S S2] Direction-agnostic pair oracle verdict.
 *
 * A swap's manipulation risk lives on whichever side is volatile, not on the side the user
 * happens to be selling. The single-token useChainlinkPrice only checks ONE side, so selling
 * USDC (input) vs buying USDC (output) produced different verdicts and a spurious "no oracle"
 * warning. This merges the input- and output-token checks symmetrically:
 *   - if EITHER token lacks a feed → oracleUnavailable, naming the missing token(s);
 *   - else → the MORE SEVERE of the two deviation/integrity verdicts. The meaningful
 *     execution-price comparison sits on the stablecoin-paired side, so the worst-case
 *     verdict is identical whether the stablecoin is the input or the output.
 *
 * Thresholds are NOT changed — it only re-uses the levels evaluateDeviation already produced.
 * When both checks are the same object (e.g. a single mocked hook), it returns that object's
 * verdict unchanged, so it is a safe drop-in for the existing gate.
 */
export function evaluatePairOracle(
  inCheck: PriceCheck,
  outCheck: PriceCheck,
  inSymbol: string,
  outSymbol: string,
): PriceCheck {
  // [FIX-PRICE-ORACLE-FAIL-CLOSED] `oracleUnavailable` now has TWO causes that must not be
  // flattened into one another: a token with no feed configured at all, and a token whose feed
  // exists but could not be READ. Only the former belongs in oracleMissingSymbols — that list
  // drives copy that names the token as having "no Chainlink oracle", which is simply false during
  // an outage. A leg is counted as missing only when it is unavailable AND did not fail a read.
  const missing: string[] = []
  if (inCheck.oracleUnavailable && !inCheck.oracleReadFailed) missing.push(inSymbol)
  if (outCheck.oracleUnavailable && !outCheck.oracleReadFailed) missing.push(outSymbol)

  // [FIX-PRICE-ORACLE-FAIL-CLOSED] A read failure on EITHER leg must survive to the pair verdict.
  // This branch used to hardcode `oracleIntegrityFailed: false`, which would have discarded the
  // hard-block signal from an unreadable leg the moment it reached the pair level — reopening, at
  // the pair level, exactly the hole the hook fix closes.
  const readFailed = !!inCheck.oracleReadFailed || !!outCheck.oracleReadFailed

  if (missing.length > 0 || readFailed) {
    // A genuinely unfeeded token (e.g. an exotic import) → ONE calm warning naming it.
    return {
      chainlinkPrice: inCheck.chainlinkPrice ?? outCheck.chainlinkPrice ?? null,
      executionPrice: inCheck.executionPrice ?? outCheck.executionPrice ?? null,
      deviation: 0,
      level: 'warn',
      // Normally the copy is supplied by the UI from oracleMissingSymbols. For a read failure that
      // framing would be false, so the failing leg's own message ("could not be read") is carried
      // through for the UI to show instead.
      message: readFailed ? (inCheck.oracleReadFailed ? inCheck.message : outCheck.message) : null,
      oracleUnavailable: true,
      // Preserved from the legs rather than hardcoded — false in the pre-existing no-feed case
      // (neither leg sets it), true when a leg could not be read, which is what hard-blocks.
      oracleIntegrityFailed: !!inCheck.oracleIntegrityFailed || !!outCheck.oracleIntegrityFailed,
      oracleReadFailed: readFailed,
      oracleMissingSymbols: missing,
    }
  }

  // Both feeds present → take the more severe verdict (integrity > danger > warn > none).
  const rank = (c: PriceCheck): number =>
    c.oracleIntegrityFailed ? 4 : c.level === 'danger' ? 3 : c.level === 'warn' ? 2 : 1
  const worse = rank(outCheck) > rank(inCheck) ? outCheck : inCheck
  return {
    ...worse,
    // Keep the INPUT token's price for display (the "Rate ✓ Verified $X" tooltip).
    chainlinkPrice: inCheck.chainlinkPrice ?? worse.chainlinkPrice,
    oracleUnavailable: false,
    oracleMissingSymbols: [],
  }
}

/**
 * [P211/FULL-H-04/M-03] Shared Chainlink round-data validity gate.
 *
 * Mirrors the inline guards in `fetchChainlinkPriceRaw` (the swap path) so the
 * order-engine oracle reads — the price-monitor live read and the historical
 * read — apply the same rigor. Returns `false` for any incomplete, invalid, or
 * stale round.
 *
 *   - `answer <= 0`              → invalid / negative price
 *   - `answeredInRound < roundId`→ answer carried over from an earlier round (stale)
 *   - `startedAt <= 0`           → round never started (incomplete)
 *   - `age > maxStalenessSec`    → data too old. Only applied when `maxStalenessSec`
 *                                  is provided; omit it for historical rounds, which
 *                                  are in the past by design.
 */
export function validateRoundData(
  roundId: bigint,
  answer: bigint,
  startedAt: bigint,
  updatedAt: bigint,
  answeredInRound: bigint,
  maxStalenessSec?: number,
): boolean {
  if (answer <= 0n) return false
  if (answeredInRound < roundId) return false
  if (startedAt <= 0n) return false
  if (maxStalenessSec !== undefined) {
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt)
    if (ageSeconds > maxStalenessSec) return false
  }
  return true
}

// ══════════════════════════════════════════════════════════
//  RAW RPC PRICE FETCHES (for DCA engine — no React hooks)
// ══════════════════════════════════════════════════════════

/**
 * Raw RPC call helper.
 *
 * [SPRINT-9G G1 / M04] Chain-aware: `chainId === 1` resolves to the mainnet
 * channel (browser → /api/rpc privacy proxy, server → RPC_URL) exactly as the
 * previous local `getRpcUrl()` did — byte-identical. Any other chain hits THAT
 * chain's RPC via `getRpcUrlForChain` and never falls back to mainnet, so an
 * L2 (Base) feed read is never made against the mainnet RPC.
 */
async function rpcCall(to: string, data: string, chainId: number = DEFAULT_CHAIN_ID): Promise<string> {
  const res = await fetch(getRpcUrlForChain(chainId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  })
  if (!res.ok) throw new Error(`RPC request failed: ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'RPC error')
  return json.result
}

/**
 * [ADR-018] Per-(chainId,address) cache of a feed's on-chain description()/decimals(). Both are
 * immutable for the lifetime of a proxy (Chainlink rotates the underlying aggregator behind the
 * SAME proxy address on an upgrade — description/decimals stay fixed across that rotation), so
 * caching for the process lifetime avoids re-reading them on every 30s poll / DCA tick without
 * ever risking a stale IDENTITY (only the price itself is re-read every time).
 */
const feedIdentityCache = new Map<string, { description: string; decimals: number }>()

/** [ADR-018] Test-only reset — mirrors _clearSequencerCache in sequencer-check.ts. Production code
 *  never calls this; the cache is intentionally process-lifetime elsewhere. */
export function _clearFeedIdentityCache(): void {
  feedIdentityCache.clear()
}

/** [ADR-018] Read a feed's on-chain description() + decimals(), cached for the process lifetime. */
async function fetchFeedIdentity(
  feed: `0x${string}`,
  chainId: number,
): Promise<{ description: string; decimals: number }> {
  const cacheKey = `${chainId}:${feed.toLowerCase()}`
  const cached = feedIdentityCache.get(cacheKey)
  if (cached) return cached

  const descData = encodeFunctionData({ abi: chainlinkAggregatorAbi, functionName: 'description' })
  const descResult = await rpcCall(feed, descData, chainId)
  const description = decodeFunctionResult({
    abi: chainlinkAggregatorAbi,
    functionName: 'description',
    data: descResult as `0x${string}`,
  }) as string

  const decData = encodeFunctionData({ abi: chainlinkAggregatorAbi, functionName: 'decimals' })
  const decResult = await rpcCall(feed, decData, chainId)
  const decimals = Number(decodeFunctionResult({
    abi: chainlinkAggregatorAbi,
    functionName: 'decimals',
    data: decResult as `0x${string}`,
  }))

  const identity = { description, decimals }
  feedIdentityCache.set(cacheKey, identity)
  return identity
}

// ══════════════════════════════════════════════════════════
//  [ADR-018] SHARED, TRANSPORT-AGNOSTIC FEED EVALUATION
//
//  The raw RPC path (fetchSingleFeedRaw, below) and the wagmi hook path
//  (useChainlinkPrice) read a feed through completely different transports, but they must reach the
//  SAME verdict. Everything below is pure — no I/O — so both callers pass in whatever they read and
//  share one implementation of the fail-closed rules. Two implementations of a fail-closed rule is
//  how one of them drifts open, which is exactly what happened when composed feeds were added to the
//  server path only and the hook silently downgraded them to "no feed configured".
// ══════════════════════════════════════════════════════════

/** [ADR-018] Why a leg was rejected. The caller owns the user-facing copy for each reason. */
export type FeedLegFailure =
  | 'identity'          // description()/decimals() contradict FEED_EXPECTATIONS (or none declared)
  | 'invalid-answer'    // answer <= 0
  | 'stale-round'       // answeredInRound < roundId
  | 'incomplete-round'  // startedAt <= 0
  | 'outdated'          // age beyond this feed's staleness ceiling

export type FeedLegVerdict =
  | { ok: true; price: number; updatedAt: number; ageSeconds: number }
  | { ok: false; reason: FeedLegFailure; ageSeconds: number }

/**
 * [ADR-018 invariants (a)(b)(c)] Does this feed self-report the identity the config declares for it?
 * Config is compared against the chain, never substituted for it. An address with NO declared
 * expectation fails — a feed we cannot identify is never trusted.
 */
export function verifyFeedIdentity(feed: string, description: string, decimals: number): boolean {
  const expectation = getFeedExpectation(feed)
  if (!expectation) return false
  return description === expectation.description && decimals === expectation.decimals
}

/**
 * [ADR-018] Evaluate ONE feed leg: self-identification → round integrity → per-feed staleness.
 * Pure; the caller supplies the values it read. `globalStalenessSec` is the caller's own fallback
 * ceiling for a feed with no declared heartbeat (raw gate 3600s, UI hook 90_000s — preserved
 * per-caller so neither path's behaviour shifts).
 */
export function evaluateFeedLeg(opts: {
  feed: string
  description: string
  decimals: number
  roundId: bigint
  answer: bigint
  startedAt: bigint
  updatedAt: bigint
  answeredInRound: bigint
  globalStalenessSec: number
  nowSec?: number
}): FeedLegVerdict {
  const { feed, description, decimals, roundId, answer, startedAt, updatedAt, answeredInRound } = opts
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const ageSeconds = now - Number(updatedAt)

  if (!verifyFeedIdentity(feed, description, decimals)) return { ok: false, reason: 'identity', ageSeconds }

  // Round INTEGRITY via the shared gate (single authority on accept/reject); if it rejects, re-derive
  // WHICH guard tripped purely to pick the right message. Staleness is applied separately below so
  // one `now` governs both the decision and the age we report.
  if (!validateRoundData(roundId, answer, startedAt, updatedAt, answeredInRound)) {
    if (answer <= 0n) return { ok: false, reason: 'invalid-answer', ageSeconds }
    if (answeredInRound < roundId) return { ok: false, reason: 'stale-round', ageSeconds }
    return { ok: false, reason: 'incomplete-round', ageSeconds }
  }

  if (ageSeconds > getFeedStalenessSec(feed, opts.globalStalenessSec)) {
    return { ok: false, reason: 'outdated', ageSeconds }
  }

  // Normalise by the ON-CHAIN decimals (never the config's) — see ADR-018 invariant (b).
  return { ok: true, price: Number(answer) / 10 ** decimals, updatedAt: Number(updatedAt), ageSeconds }
}

/**
 * [ADR-018 invariant (d) / SPRINT-9V V2] Combine two validated legs into one quote:
 * price = base × quote, freshness = the OLDER leg (conservative — a composition is only as fresh as
 * its stalest input). Callers must have already accepted BOTH legs via evaluateFeedLeg; there is no
 * partial pricing.
 */
export function composeFeedLegs(
  base: { price: number; updatedAt: number },
  quote: { price: number; updatedAt: number },
): { price: number; updatedAt: number } {
  return { price: base.price * quote.price, updatedAt: Math.min(base.updatedAt, quote.updatedAt) }
}

/**
 * [ADR-018 / L-1] Read a feed's on-chain identity AND enforce it against FEED_EXPECTATIONS.
 * Returns the VERIFIED on-chain identity, or null when the feed has no declared expectation or
 * self-reports something else. Extracted so every read path — the live gate (fetchSingleFeedRaw)
 * and the historical walk (fetchHistoricalPrice) — enforces the check through ONE implementation
 * rather than each re-deriving it (invariant (e): no fallback path may bypass the check).
 *
 * Read failures (no code / revert / transport) propagate as a rejection rather than becoming null;
 * only a REACHABLE feed whose identity does not match is a null. That distinction is the
 * pre-existing contract pinned by TEST-H-01 and is preserved here.
 */
async function resolveVerifiedIdentity(
  feed: `0x${string}`,
  chainId: number,
): Promise<{ description: string; decimals: number } | null> {
  if (!getFeedExpectation(feed)) return null // no declared identity → cannot self-identify → fail closed

  const identity = await fetchFeedIdentity(feed, chainId)

  // [ADR-018 invariant (c)] Identity comparison goes through the SHARED verifyFeedIdentity so this
  // path and the UI hook can never disagree about what counts as a match.
  return verifyFeedIdentity(feed, identity.description, identity.decimals) ? identity : null
}

/**
 * [SPRINT-9V V2 / ADR-018] Read + fully validate ONE Chainlink feed: self-identification (description
 * + decimals against FEED_EXPECTATIONS — MUST match before the answer is trusted) + latestRoundData +
 * the 9G round-integrity gate + per-feed staleness. Returns the decimal-normalised price or null. The
 * sequencer gate is the CALLER's responsibility (done once per fetch, before any leg is read).
 *
 * [ADR-018 invariant (b)/(c)] Config (FEED_EXPECTATIONS) is never trusted on its own and never
 * substituted for an on-chain value — it is only ever compared against what the feed itself reports.
 * The price below is always computed from `identity.decimals` (the ON-CHAIN reading), never from the
 * config's expectedDecimals, even on a passing match. A feed with no declared expectation at all
 * fails closed (null) rather than being read un-checked.
 */
async function fetchSingleFeedRaw(
  feed: `0x${string}`,
  chainId: number,
): Promise<{ price: number; updatedAt: number; roundId: bigint } | null> {
  // [ADR-018] Self-identify BEFORE the answer is read or trusted. Shared with fetchHistoricalPrice
  // so both paths enforce one implementation. rpcCall failures propagate (TEST-H-01 contract).
  const identity = await resolveVerifiedIdentity(feed, chainId)
  if (!identity) return null

  // Fetch latestRoundData
  const lrdData = encodeFunctionData({
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
  })
  const lrdResult = await rpcCall(feed, lrdData, chainId)
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = decodeFunctionResult({
    abi: chainlinkAggregatorAbi,
    functionName: 'latestRoundData',
    data: lrdResult as `0x${string}`,
  }) as [bigint, bigint, bigint, bigint, bigint]

  // [SPRINT-9G G8 / SPRINT-9V V1 / ADR-018] Round integrity + per-feed staleness, via the SHARED
  // evaluateFeedLeg — the same function the UI hook calls, so the two paths cannot diverge on what
  // counts as a valid leg. Covers answer<=0, answeredInRound<roundId, startedAt<=0, and
  // heartbeat×1.5 staleness (else the global CHAINLINK_MAX_STALENESS_SEC, unchanged for mainnet).
  // Decimals are normalised per-leg from the feed's own ON-CHAIN value inside the shared evaluator.
  const verdict = evaluateFeedLeg({
    feed,
    description: identity.description,
    decimals: identity.decimals,
    roundId, answer, startedAt, updatedAt, answeredInRound,
    globalStalenessSec: CHAINLINK_MAX_STALENESS_SEC,
  })
  if (!verdict.ok) return null

  return { price: verdict.price, updatedAt: verdict.updatedAt, roundId }
}

/**
 * Fetch current Chainlink USD price for a token via direct RPC (non-hook).
 * Returns price as a number (e.g. 2850.42) or null if no feed exists.
 *
 * [SPRINT-9V V2 / ADR-018] If the token has no DIRECT USD feed but a COMPOSED one (e.g. Base cbETH →
 * cbETH/ETH × ETH/USD), both legs are read and validated INDEPENDENTLY (self-identification +
 * integrity + staleness, via fetchSingleFeedRaw); the product is returned only when BOTH pass —
 * either leg invalid/stale/misidentified → null (no partial pricing), exactly like a missing direct
 * feed, so the existing calm no-oracle + multi-source fallback kicks in.
 *
 * [ADR-018] Dispatches on resolveFeed's `kind` discriminant — the `default` arm's `never` assignment
 * makes the single/composed split exhaustive at compile time: a third ResolvedFeed shape added later
 * fails the build here until handled, rather than silently falling through unread.
 */
export async function fetchChainlinkPriceRaw(
  tokenAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<{ price: number; updatedAt: number; roundId: bigint } | null> {
  const resolved = resolveFeed(tokenAddress, chainId)
  if (!resolved) return null

  // [P218] L2 sequencer-uptime gate — never price on a down/recovering
  // sequencer. Mainnet (DEFAULT_CHAIN_ID) has no sequencer feed and skips this,
  // so the mainnet path is unchanged. Done ONCE up front; both composed legs share the chain.
  if (chainId !== DEFAULT_CHAIN_ID) {
    const seqUp = await isSequencerUp(chainId, getPublicClientForChain(chainId))
    if (!seqUp) {
      console.warn(`[TeraSwap] Sequencer down or in grace period on chain ${chainId}`)
      return null
    }
  }

  switch (resolved.kind) {
    case 'single':
      return fetchSingleFeedRaw(resolved.leg.address, chainId)

    case 'composed': {
      // [SPRINT-9V V2] Composed: token/USD = base(token/ETH) × quote(ETH/USD). BOTH legs must pass
      // self-identification + integrity + per-feed staleness; either invalid → unavailable (no
      // partial pricing).
      const base = await fetchSingleFeedRaw(resolved.base.address, chainId)
      if (!base) return null
      const quote = await fetchSingleFeedRaw(resolved.quote.address, chainId)
      if (!quote) return null
      // [ADR-018 invariant (d)] Product + oldest-leg freshness via the SHARED composeFeedLegs, so the
      // UI hook composes identically (price = base × quote, updatedAt = the older leg).
      return {
        ...composeFeedLegs(base, quote),
        roundId: base.roundId, // representative (base leg); composition has no single round
      }
    }

    default: {
      const exhaustive: never = resolved
      return exhaustive
    }
  }
}

/**
 * Fetch historical Chainlink price ~targetAgeSeconds ago.
 *
 * Strategy: walk backwards from latestRoundId, stepping by larger jumps,
 * then binary-searching to find the round closest to the target timestamp.
 * Max 20 RPC calls to avoid excessive usage.
 *
 * Returns price at the round closest to targetAge, or null if unavailable.
 *
 * [ADR-018 / audit L-1] This walk reads raw `answer`s from getRoundData and normalises them by a
 * separately-read decimals(), which bypassed the identity gate. It is now routed through the SAME
 * resolveVerifiedIdentity check as the live path, and normalises by that VERIFIED decimals — so
 * there is no read path in this module that can price a feed without first confirming what it is
 * (ADR-018 invariant (e)).
 *
 * L-1 was "delete OR gate"; gating was chosen. The function is exported and covered by tests, so
 * gating is the smaller and lower-risk diff than removing it, it aligns with the repo's
 * preserve-don't-delete convention, it removes a redundant decimals() RPC call by reusing the
 * cached identity, and — decisively — any future consumer inherits the guard automatically,
 * whereas deleting it invites a later re-implementation that reintroduces the ungated pattern.
 *
 * NOTE: only DIRECT feeds are supported here (getChainlinkFeed). A composed token (mainnet
 * GRT/LDO/SHIB/WBTC, Base cbETH) returns null — historical composition is not implemented, and
 * returning null is the correct fail-closed answer rather than a single-leg half price.
 */
export async function fetchHistoricalPrice(
  tokenAddress: string,
  targetAgeSeconds: number = 86400, // default 24h
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<{ price: number; timestamp: number } | null> {
  const feed = getChainlinkFeed(tokenAddress, chainId)
  if (!feed) return null

  try {
    // Get current round info (also runs the L2 sequencer gate via fetchChainlinkPriceRaw)
    const current = await fetchChainlinkPriceRaw(tokenAddress, chainId)
    if (!current) return null

    const targetTimestamp = current.updatedAt - targetAgeSeconds
    const { roundId: latestRoundId } = current

    // Chainlink phase-aware round IDs:
    // roundId = (phaseId << 64) | aggregatorRoundId
    // We can only walk within the current phase
    const phaseId = latestRoundId >> 64n
    const aggregatorRoundId = latestRoundId & ((1n << 64n) - 1n)

    // Binary search within the phase
    let low = 1n
    let high = aggregatorRoundId
    let bestPrice: number | null = null
    let bestTimestamp = 0
    let bestDiff = Infinity
    let calls = 0
    const maxCalls = 16

    // [ADR-018 / L-1] Identity-gated decimals. Replaces a bare decimals() read that trusted
    // whatever the address returned. Cached, so this is normally free after the
    // fetchChainlinkPriceRaw call above already warmed it — one fewer RPC round-trip than before.
    const identity = await resolveVerifiedIdentity(feed, chainId)
    if (!identity) return null
    const decimals = identity.decimals

    while (low <= high && calls < maxCalls) {
      const mid = (low + high) / 2n
      const fullRoundId = (phaseId << 64n) | mid

      try {
        const rdData = encodeFunctionData({
          abi: chainlinkAggregatorAbi,
          functionName: 'getRoundData',
          args: [fullRoundId],
        })
        const rdResult = await rpcCall(feed, rdData, chainId)
        const [rRoundId, answer, startedAt, updatedAt, answeredInRound] = decodeFunctionResult({
          abi: chainlinkAggregatorAbi,
          functionName: 'getRoundData',
          data: rdResult as `0x${string}`,
        }) as [bigint, bigint, bigint, bigint, bigint]

        calls++

        // [P211/FULL-M-03] Skip incomplete/invalid rounds — never use them as a
        // price data point. Staleness is intentionally NOT checked here:
        // historical rounds are in the past by design. Treat an invalid round
        // like a missing one (shrink the upper bound and keep searching).
        if (!validateRoundData(rRoundId, answer, startedAt, updatedAt, answeredInRound)) {
          high = mid - 1n
          continue
        }

        const ts = Number(updatedAt)
        const diff = Math.abs(ts - targetTimestamp)

        if (diff < bestDiff) {
          bestDiff = diff
          bestPrice = Number(answer) / 10 ** decimals
          bestTimestamp = ts
        }

        if (ts < targetTimestamp) {
          low = mid + 1n
        } else if (ts > targetTimestamp) {
          high = mid - 1n
        } else {
          break // exact match
        }
      } catch {
        // Round might not exist, shrink range
        high = mid - 1n
        calls++
      }
    }

    if (bestPrice !== null && bestDiff < targetAgeSeconds * 0.5) {
      // Accept if within 50% of target age (e.g. for 24h target, accept 12h-36h)
      return { price: bestPrice, timestamp: bestTimestamp }
    }

    return null
  } catch {
    return null
  }
}

// ══════════════════════════════════════════════════════════
//  [10-L-03] SERVER-SIDE USD VALUATION
//
//  These helpers exist so server routes (e.g. /api/log-swap) can compute
//  amountInUsd themselves rather than trusting a client-controlled value
//  for monitoring thresholds. They reuse the same RPC channel as
//  fetchChainlinkPriceRaw so there is no new oracle plumbing.
// ══════════════════════════════════════════════════════════

const ERC20_DECIMALS_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const

/**
 * Fetch an ERC-20 token's `decimals()` value via direct RPC.
 *
 * Returns null when the call fails or the result is outside the typical
 * ERC-20 range (1..30) — defends against contracts that revert on
 * decimals() or return garbage. Callers should treat null as "decimals
 * unknown, skip server-side USD computation".
 */
export async function fetchErc20Decimals(
  tokenAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<number | null> {
  try {
    const data = encodeFunctionData({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals' })
    const result = await rpcCall(tokenAddress, data, chainId)
    if (!result || result === '0x') return null
    const decoded = decodeFunctionResult({
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
      data: result as `0x${string}`,
    }) as number
    if (!Number.isInteger(decoded) || decoded < 1 || decoded > 30) return null
    return decoded
  } catch {
    return null
  }
}

/**
 * [10-L-03] Server-trusted USD valuation of a raw wei token amount.
 *
 * Pulls the Chainlink price + the token's ERC-20 decimals via RPC and
 * computes `usd = (rawAmount / 10^decimals) * price`. Returns null when
 * any step fails — caller decides whether to fall back to a client-
 * supplied figure (with a flag) or skip the threshold check.
 *
 * Uses BigInt arithmetic for the divisor to preserve precision on
 * decimal-heavy tokens (USDC 6, WBTC 8, etc. — Number(rawWei) on 18-dec
 * tokens above ~9007 ETH starts losing integer precision).
 */
export async function computeTokenAmountUsd(
  tokenAddress: string,
  rawAmountWei: string,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<{ usd: number; price: number; decimals: number } | null> {
  if (!tokenAddress || !rawAmountWei) return null

  // Parallelise the two RPC calls — they're independent.
  const [priceResult, decimals] = await Promise.all([
    fetchChainlinkPriceRaw(tokenAddress, chainId).catch(() => null),
    fetchErc20Decimals(tokenAddress, chainId).catch(() => null),
  ])

  if (!priceResult) return null
  if (decimals === null) return null

  try {
    const rawBn = BigInt(rawAmountWei)
    if (rawBn < 0n) return null
    const divisor = 10n ** BigInt(decimals)
    // Two-part conversion preserves precision: take the integer part as
    // a BigInt → Number cast (always safe within 53 bits for any realistic
    // token amount), then add the fractional part as a float.
    const integerPart = Number(rawBn / divisor)
    const fractionalPart = Number(rawBn % divisor) / Number(divisor)
    const tokenAmount = integerPart + fractionalPart
    if (!Number.isFinite(tokenAmount)) return null
    return { usd: tokenAmount * priceResult.price, price: priceResult.price, decimals }
  } catch {
    return null
  }
}
