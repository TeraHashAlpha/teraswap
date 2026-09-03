/**
 * [ADR-023] 0x Settler identity — resolved from 0x's deployer/registry, never whitelisted.
 *
 * ADR-021 established that the address 0x's `AllowanceHolder.exec` calls — the
 * `Settler` — ROTATES with each 0x release. A rotating address cannot live in a
 * hand-kept allowlist: the list is stale the moment 0x ships, and "fix it by
 * hand later" is exactly the address-hygiene failure this repo derives its way
 * out of everywhere else.
 *
 * 0x's own integration guide is unambiguous about the alternative:
 *
 *   "Do not hardcode any `Settler` address in your integration. ***ALWAYS***
 *    query the deployer/registry for the address of the most recent `Settler`
 *    contract before building or signing a transaction, metatransaction, or
 *    order."
 *   — https://github.com/0xProject/0x-settler/blob/master/README.md
 *
 * The registry is an ERC721-shaped contract at the SAME address on every chain.
 * `ownerOf(featureId)` is the current Settler for a feature; `prev(featureId)`
 * is the one it replaced, which stays live through 0x's "dwell" window (0x API
 * keeps emitting calldata for the previous release while the new one is
 * end-to-end tested). Accepting BOTH is 0x's documented reference check, and it
 * is not theoretical: on 2026-09-03 every observed `exec` on mainnet, Base and
 * Arbitrum targeted `prev(2)`, not `ownerOf(2)` — see the golden vectors in
 * `src/lib/__fixtures__/zerox-allowance-holder-*.ts`.
 *
 * Everything here fails CLOSED. A throw, an undeployed registry, an empty
 * return, a malformed word or the zero address all reject the swap; there is no
 * static fallback list and no cross-chain fallback. A rejected read is never
 * cached, so a transient RPC blip cannot pin 0x shut for a whole TTL window.
 */

import { getPublicClientForChain } from '@/lib/chains/clients'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * 0x's deployer/registry, documented as living at this address on every chain.
 *
 * This is the ONE address that may be pinned, because it is the root of trust
 * the rest is derived from — there is nothing above it to derive it from. It is
 * checked at use time on every chain with `eth_getCode` (below): read on
 * 2026-09-03 it carried the same 58-byte runtime on chain 1 (block 25897835),
 * 8453 (block 50834728) and 42161 (block 501399900).
 */
export const ZEROX_DEPLOYER_ADDRESS = '0x00000000000004533Fe15556B1E086BB1A72cEae' as const

/**
 * The registry feature id for the flow THIS repo uses — derived, not assumed.
 *
 * Two independent lines of evidence, both dated 2026-09-03:
 *
 *  1. 0x's README enumerates the features: "For taker-submitted flows, the
 *     feature number is probably 2 … For gasless/metatransaction flows, the
 *     feature number is probably 3. For intents, … 4. For bridge settler, … 5."
 *     Its TypeScript example labels them `{2: "taker submitted", 3:
 *     "metatransaction", 4: "intents", 5: "bridge"}`. `src/lib/adapters/zerox.ts`
 *     calls `/swap/allowance-holder/quote` with `taker`, and ADR-021 established
 *     there is NO signing anywhere on this repo's swap path — so the flow is
 *     taker-submitted, and only taker-submitted.
 *
 *  2. Live traffic. Every successful `AllowanceHolder.exec` sampled on chains 1,
 *     8453 and 42161 targeted that chain's feature-2 address (specifically
 *     `prev(2)`, see the dwell note above). The feature-5 (bridge) Settlers also
 *     see traffic on chains 1 and 42161 — this repo never produces it, and the
 *     narrower set is the safer one, so features 3, 4 and 5 are NOT admitted.
 *
 * `uint128` on the wire for `prev`/`next`, `uint256` for `ownerOf`; viem encodes
 * the same bigint correctly for both.
 */
export const ZEROX_TAKER_SUBMITTED_FEATURE_ID = 2n

/**
 * How long a successful resolution is reused, per chain.
 *
 * 30s is the same figure `chains/sequencer-check.ts` uses for the same shape of
 * read, and it is bounded by what it is protecting against on both sides:
 *
 *  - Too long is unsafe only in the trivial direction. A rotation moves an
 *    address INTO the set (the new `ownerOf`); the address leaving is the old
 *    `prev`, which 0x API has already stopped emitting. So a stale window can
 *    only reject a genuine swap, never admit a stale one — and it self-heals
 *    within the window.
 *  - Too short costs an RPC round trip on the swap path. 30s collapses a burst
 *    of swaps into one read while staying four orders of magnitude below 0x's
 *    dwell window, which runs hours to days.
 */
export const ZEROX_SETTLER_CACHE_TTL_MS = 30_000

/** Sentinel: an EVM address is 42 characters, `0x` + 20 bytes. */
const ADDRESS_LENGTH = 42
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

if (ZEROX_DEPLOYER_ADDRESS.length !== ADDRESS_LENGTH) {
  throw new Error(
    `[ADR-023] 0x deployer address is malformed: ${ZEROX_DEPLOYER_ADDRESS} (expected ${ADDRESS_LENGTH} chars)`,
  )
}

const DEPLOYER_ABI = [
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'featureId', type: 'uint128' }],
    name: 'prev',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

type DeployerReadFn = 'ownerOf' | 'prev'

/**
 * Structural — a viem PublicClient or a test mock both satisfy it without
 * overload friction. `chain` is optional so mocks need not fake it; when it IS
 * present it is asserted against the requested chain, so a mis-wired client can
 * never answer for the wrong network.
 */
export interface SettlerRegistryClient {
  chain?: { id?: number } | null
  getCode(args: { address: `0x${string}` }): Promise<string | undefined>
  readContract(args: {
    address: `0x${string}`
    abi: typeof DEPLOYER_ABI
    functionName: DeployerReadFn
    args: readonly [bigint]
  }): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Cache — successes only, per chain
// ---------------------------------------------------------------------------

interface CacheEntry {
  settlers: ReadonlySet<string>
  expiresAt: number
}

const cache = new Map<number, CacheEntry>()

/** Concurrent misses share ONE read instead of each paying their own. */
const inFlight = new Map<number, Promise<ReadonlySet<string>>>()

/** Test-only: reset the per-chain cache between cases. */
export function _clearZeroxSettlerCache(): void {
  cache.clear()
  inFlight.clear()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readFeatureAddress(
  client: SettlerRegistryClient,
  functionName: DeployerReadFn,
  chainId: number,
): Promise<string> {
  const featureId = ZEROX_TAKER_SUBMITTED_FEATURE_ID
  let raw: unknown
  try {
    raw = await client.readContract({
      address: ZEROX_DEPLOYER_ADDRESS,
      abi: DEPLOYER_ABI,
      functionName,
      args: [featureId],
    })
  } catch (err) {
    // A revert from `ownerOf` is 0x's documented "Settler is paused, do not
    // interact" signal. It is not distinguishable here from an RPC failure, and
    // both mean the same thing to us: do not admit the target.
    throw new Error(
      `0x registry ${functionName}(${featureId}) failed on chain ${chainId}: ${describe(err)}`,
    )
  }

  if (typeof raw !== 'string' || !ADDRESS_RE.test(raw)) {
    // Covers empty returndata ('0x'), a non-string, and any short/garbled word.
    throw new Error(
      `0x registry ${functionName}(${featureId}) returned a malformed address on chain ${chainId}: ${String(raw)}`,
    )
  }

  const address = raw.toLowerCase()
  if (address === ZERO_ADDRESS) {
    throw new Error(
      `0x registry ${functionName}(${featureId}) returned the zero address on chain ${chainId}`,
    )
  }
  return address
}

async function readSettlers(
  chainId: number,
  client: SettlerRegistryClient,
): Promise<ReadonlySet<string>> {
  const clientChainId = client.chain?.id
  if (typeof clientChainId === 'number' && clientChainId !== chainId) {
    throw new Error(
      `0x registry client is bound to chain ${clientChainId}, not ${chainId} — refusing a cross-chain answer`,
    )
  }

  // The registry must actually exist HERE. Same address everywhere is a
  // convention, not a guarantee: on a chain where 0x never deployed it, the
  // address is a code-less EOA slot and every `readContract` below would decode
  // empty returndata. No code ⇒ this chain fails closed.
  let code: string | undefined
  try {
    code = await client.getCode({ address: ZEROX_DEPLOYER_ADDRESS })
  } catch (err) {
    throw new Error(
      `0x deployer/registry code read failed on chain ${chainId}: ${describe(err)}`,
    )
  }
  if (!code || code === '0x') {
    throw new Error(
      `0x deployer/registry ${ZEROX_DEPLOYER_ADDRESS} has no code on chain ${chainId}`,
    )
  }

  // allSettled, not all: `all` would leave the sibling promise's rejection
  // unhandled when the first one fails.
  const [current, previous] = await Promise.allSettled([
    readFeatureAddress(client, 'ownerOf', chainId),
    readFeatureAddress(client, 'prev', chainId),
  ])
  if (current.status === 'rejected') throw current.reason
  if (previous.status === 'rejected') throw previous.reason

  return new Set([current.value, previous.value])
}

/**
 * The lower-cased addresses admitted as a 0x Settler on `chainId` right now:
 * `ownerOf(2)` and `prev(2)`, exactly 0x's documented reference check.
 *
 * REJECTS by throwing on any failure. Callers must treat a throw as "do not
 * execute this swap" — never as "fall back to something else".
 */
export async function resolveZeroxSettlers(
  chainId: number,
  publicClient?: SettlerRegistryClient,
): Promise<ReadonlySet<string>> {
  const cached = cache.get(chainId)
  if (cached && cached.expiresAt > Date.now()) return cached.settlers

  const pending = inFlight.get(chainId)
  if (pending) return pending

  const client =
    publicClient ?? (getPublicClientForChain(chainId) as unknown as SettlerRegistryClient)

  const flight = (async (): Promise<ReadonlySet<string>> => {
    const settlers = await readSettlers(chainId, client)
    // Only a SUCCESS is cached. A failure must be retried on the next swap
    // rather than pinning 0x shut for the rest of the TTL window.
    cache.set(chainId, { settlers, expiresAt: Date.now() + ZEROX_SETTLER_CACHE_TTL_MS })
    return settlers
  })()

  inFlight.set(chainId, flight)
  try {
    return await flight
  } finally {
    inFlight.delete(chainId)
  }
}
