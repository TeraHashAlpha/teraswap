/**
 * [SPRINT-DCA-UNGATE] DCA launch flag + Base-only gating.
 *
 * The DCA tab is built but stays the "Soon" teaser until the launch flag is
 * flipped at go-live (after the manual e2e + router whitelist + executor
 * funding). Keeping the gate here — not inline in page.tsx — makes it unit
 * testable and keeps the page component thin.
 *
 * Go-live = set NEXT_PUBLIC_DCA_ENABLED=true in the Base deployment env. No
 * code change required to launch.
 */

import { isChainActive } from '@/lib/chains'
import { getOrderExecutor } from '@/lib/order-engine'

/** The only chain DCA is offered on (conditional orders are L2-only). */
export const BASE_CHAIN_ID = 8453

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
 *   2. the wallet is connected to Base (8453),
 *   3. Base is an active chain (FeeCollector configured), and
 *   4. an OrderExecutor is wired for the connected chain.
 *
 * The explicit `chainId === BASE_CHAIN_ID` pin is load-bearing: getOrderExecutor(1)
 * (mainnet) is ALSO non-null, so without it mainnet would wrongly offer DCA. The
 * pin is what enforces "Base only / mainnet not offered".
 */
export function isDcaLive(chainId: number): boolean {
  return (
    isDcaLaunchEnabled() &&
    chainId === BASE_CHAIN_ID &&
    isChainActive(BASE_CHAIN_ID) &&
    getOrderExecutor(chainId) !== null
  )
}
