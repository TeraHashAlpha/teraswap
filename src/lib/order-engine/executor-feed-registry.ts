/**
 * [FIX-DCA-NOFEED-FAIL-CLOSED] Does the ACTIVE chain's OrderExecutorV3 hold a registered
 * fair-value feed for BOTH legs of an order? Asked of the executor's OWN `tokenUsdFeeds`
 * registry — the exact mapping `_fairValueOut` consults through `_readFeedUsd`
 * (TeraSwapOrderExecutorV3.sol:1046 / 1076-1090) — never the frontend CHAINLINK_FEEDS table,
 * never an env list, never a hardcoded chain id.
 *
 * WHY THE CONTRACT AND NOT A LIST. The frontend registry (`resolveFeed`) answers "can the BROWSER
 * price this token", which is a different question with a different answer. What decides the
 * on-chain floor is one bit inside the executor:
 *
 *     (uint256 fairOut, bool hasFeed) = _fairValueOut(order.tokenIn, order.tokenOut, netAmount);
 *     uint256 floorOut = scaledMin;
 *     if (hasFeed) { ... if (oracleFloor > floorOut) floorOut = oracleFloor; }   // V3:540-554
 *
 * `hasFeed` is false when EITHER leg is unregistered, so the whole on-chain fill protection
 * collapses to `scaledMin` — the user's signed absolute minimum scaled to the chunk. For a DCA
 * whose output token could not be priced at signing time that signed minimum is the ADR-013
 * fallback (v3-min-derivation.ts:247-249): ~0.0001 whole tokenOut, deliberately non-zero so the
 * contract's `InvalidMinOutput` never fires, and just as deliberately NOT economically meaningful.
 * A keeper could then fill at almost any price. Same class as finding B2 in
 * `Audits/Sprint/ARBITRUM-V3-STATE-2026-08-26.md:240`.
 *
 * Owner decision 2026-09-09: fail closed. Deriving a real floor from the aggregator quote is a
 * later change; this module only refuses what it cannot verify.
 *
 * FAIL CLOSED IN BOTH DIRECTIONS, which is the whole point:
 *   - a leg the executor has not registered  ⇒ blocked, naming that leg;
 *   - a registry we could not READ at all (RPC down, no executor configured, an answer whose shape
 *     we do not recognise) ⇒ also blocked. "We could not check" must never read as "checked, fine";
 *     that conflation is what the swap flow's own oracle gate was fixed for.
 *
 * ADDRESS FIDELITY IS LOAD-BEARING. `_fairValueOut` is called with `order.tokenIn` / `order.tokenOut`
 * — the addresses as SIGNED. Callers must pass those exact addresses (i.e. after any native→wrapped
 * resolution the signing path itself performs, and no other normalisation). Normalising an address
 * here that the signed struct does not normalise would answer a question the contract never asks
 * and turn this gate fail-open.
 *
 * This is a CLIENT guard: it narrows the window in which a user spends an approval and a signature
 * on an order the contract cannot protect. The authoritative checks stay where they are — the
 * server gate in `src/app/api/orders/route.ts` and, terminally, `max(oracleFloor, scaledMin)`
 * on-chain.
 */

import { ORDER_EXECUTOR_V3_ABI } from './abi'

/** The executor's own registry accessor. Named so a test (and a reader) can point at the source. */
export const EXECUTOR_FEED_REGISTRY_FN = 'tokenUsdFeeds' as const

export interface ExecutorFeedLeg {
  /** Which side of the order this is — used verbatim in the copy, so the user is told WHICH leg. */
  role: 'spend' | 'buy'
  symbol: string
  /** EXACTLY the address that will be signed into the order struct. See "address fidelity" above. */
  address: string
}

export interface ExecutorFeedCoverage {
  /** true ⇒ every leg has a registered fair-value feed and the order may proceed to approve/sign. */
  ok: boolean
  /** The legs the executor has no registered feed for (empty when `unreadable`). */
  unregistered: ExecutorFeedLeg[]
  /** true ⇒ the registry itself could not be consulted; `ok` is false for that reason alone. */
  unreadable: boolean
  /** User-facing reason when blocked, else null. */
  reason: string | null
}

/**
 * The narrow slice of a viem PublicClient this module needs. Declared structurally so the caller
 * passes the real per-chain client (`getPublicClientForChain(chainId)`) and a test passes a stub,
 * without either side importing the other's world.
 */
export interface ExecutorFeedReader {
  readContract(args: {
    address: `0x${string}`
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }): Promise<unknown>
}

export interface ExecutorFeedCoverageParams {
  reader: ExecutorFeedReader
  /** The OrderExecutorV3 for the ACTIVE chain (`getOrderExecutorV3(chainId)`); null ⇒ blocked. */
  executor: string | null
  /** The chain's own display name, from the registry — never a literal. */
  chainName: string
  legs: readonly ExecutorFeedLeg[]
}

function legLabel(leg: ExecutorFeedLeg): string {
  return `${leg.symbol} (the token you're ${leg.role === 'buy' ? 'buying' : 'spending'})`
}

/**
 * Read `registered` out of whatever `tokenUsdFeeds(address)` came back as. viem decodes a
 * multi-output function to a positional tuple; an object keyed by output name is accepted too so a
 * viem upgrade cannot silently turn this into "not registered". Anything else returns null, which
 * the caller treats as UNREADABLE — an unrecognised answer is not a "no", and it is certainly not
 * a "yes".
 */
function readRegisteredFlag(raw: unknown): boolean | null {
  if (Array.isArray(raw)) {
    return typeof raw[4] === 'boolean' ? raw[4] : null
  }
  if (raw !== null && typeof raw === 'object' && 'registered' in raw) {
    const value = (raw as { registered: unknown }).registered
    return typeof value === 'boolean' ? value : null
  }
  return null
}

function unreadableResult(chainName: string): ExecutorFeedCoverage {
  return {
    ok: false,
    unregistered: [],
    unreadable: true,
    reason:
      `Recurring buys are paused for this pair: we could not check with the order engine on ` +
      `${chainName} whether these tokens have a live price source, so we will not start a ` +
      `multi-day order we cannot price. Try again in a moment.`,
  }
}

function missingResult(unregistered: ExecutorFeedLeg[], chainName: string): ExecutorFeedCoverage {
  const names = unregistered.map(legLabel).join(' and ')
  const plural = unregistered.length > 1
  return {
    ok: false,
    unregistered,
    unreadable: false,
    reason:
      `Recurring buys are unavailable for ${names}: the order engine on ${chainName} has no ` +
      `registered price source for ${plural ? 'these tokens' : 'this token'}, so every buy would ` +
      `run without a live-price floor. Pick a token the order engine can price, or swap instantly ` +
      `instead of scheduling.`,
  }
}

/**
 * Ask the executor whether both legs are priceable on-chain. Blocks unless every leg answers
 * `registered: true`.
 */
export async function readExecutorFeedCoverage(
  p: ExecutorFeedCoverageParams,
): Promise<ExecutorFeedCoverage> {
  // No executor on this chain ⇒ nothing to ask, and nothing that could enforce an oracle floor
  // either. Blocked for the same reason as an unreadable registry, not waved through.
  if (!p.executor) return unreadableResult(p.chainName)
  if (p.legs.length === 0) return unreadableResult(p.chainName)

  let answers: unknown[]
  try {
    answers = await Promise.all(
      p.legs.map(leg =>
        p.reader.readContract({
          address: p.executor as `0x${string}`,
          abi: ORDER_EXECUTOR_V3_ABI,
          functionName: EXECUTOR_FEED_REGISTRY_FN,
          args: [leg.address as `0x${string}`],
        }),
      ),
    )
  } catch {
    return unreadableResult(p.chainName)
  }

  const unregistered: ExecutorFeedLeg[] = []
  for (let i = 0; i < p.legs.length; i++) {
    const registered = readRegisteredFlag(answers[i])
    if (registered === null) return unreadableResult(p.chainName)
    if (!registered) unregistered.push(p.legs[i])
  }

  if (unregistered.length > 0) return missingResult(unregistered, p.chainName)
  return { ok: true, unregistered: [], unreadable: false, reason: null }
}
