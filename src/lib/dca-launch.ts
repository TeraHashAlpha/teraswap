/**
 * [SPRINT-DCA-UNGATE, generalized SPRINT-48-ARBITRUM-DCA-PREP] DCA launch flag + chain gating.
 *
 * The DCA tab is built but stays the "Soon" teaser until the launch flag is
 * flipped at go-live (after the manual e2e + router whitelist + executor
 * funding). Keeping the gate here — not inline in page.tsx — makes it unit
 * testable and keeps the page component thin.
 *
 * Go-live = set NEXT_PUBLIC_DCA_ENABLED=true in the deployment env. No code
 * change required to launch on a chain already in DCA_CHAINS with a wired v3
 * executor.
 */

import { isChainActive } from '@/lib/chains'
import { getOrderExecutorV3 } from '@/lib/order-engine'

/** The only chain DCA is offered on (conditional orders are L2-only) — kept as the
 *  historical Base constant; the live allowlist is DCA_CHAINS below. */
export const BASE_CHAIN_ID = 8453

/**
 * [SPRINT-48-ARBITRUM-DCA-PREP] Compile-time allowlist of chains DCA may ever be offered
 * on. This REPLACES the old hard `chainId === BASE_CHAIN_ID` pin — that pin's job (block
 * mainnet, which has a non-null v2 AND may one day have a non-null v3 executor, from ever
 * offering DCA) is now done by mainnet's absence from this list, not by an equality check
 * against a single chain. Adding a chain here is still NOT enough by itself: it must also
 * (a) be active (isChainActive) and (b) have a real OrderExecutorV3 wired
 * (getOrderExecutorV3(chainId) !== null) — see isDcaLive below. Today Arbitrum's v3 slot is
 * unset (SPRINT-48-ARBITRUM-DCA-PREP shipped dark), so isDcaLive(42161) stays false despite
 * being in this list.
 */
export const DCA_CHAINS: readonly number[] = [8453, 42161]

/**
 * The launch flag. Default OFF: only the exact literal "true" enables it, so a
 * stray "1" / "TRUE" / "" can never accidentally launch DCA. Read at call time
 * (not module scope) so it reflects the build-time-inlined value in production
 * and stays flippable in tests.
 */
export function isDcaLaunchEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DCA_ENABLED === 'true'
}

/**
 * Whether the functional DCA panel may be offered for the connected chain.
 * ALL must hold:
 *   1. the launch flag is on,
 *   2. the chain is in the explicit DCA_CHAINS allowlist,
 *   3. the chain is active (FeeCollector configured), and
 *   4. an OrderExecutorV3 is wired for the connected chain.
 *
 * [SPRINT-48-ARBITRUM-DCA-PREP] Generalizes the old `chainId === BASE_CHAIN_ID` pin to
 * `DCA_CHAINS.includes(chainId)`. Mainnet (1) is deliberately absent from DCA_CHAINS, so it
 * stays excluded even though it has (and may keep) a non-null v2/v3 executor — that absence
 * is the ENTIRE mechanism preventing the leak the old pin existed to prevent; see the test
 * pinning this. Also switched from getOrderExecutor (v2) to getOrderExecutorV3 — DCA signing
 * moved to v3 (SPRINT-V3-P4), so the gate must track the executor DCA actually signs against.
 */
export function isDcaLive(chainId: number): boolean {
  return (
    isDcaLaunchEnabled() &&
    DCA_CHAINS.includes(chainId) &&
    isChainActive(chainId) &&
    getOrderExecutorV3(chainId) !== null
  )
}
