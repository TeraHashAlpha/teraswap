/**
 * [fix/zerox-partner-fee-armed] Which mechanism actually collects TeraSwap's
 * fee on a given (source, chain).
 *
 * There are exactly three fee modes, and they are mutually exclusive:
 *
 *   'native-partner-fee'  The aggregator's own API deducts the fee and pays
 *                         FEE_RECIPIENT directly, because the adapter attached
 *                         partner-fee params (FEE_NATIVE_SOURCES — 0x, CoW,
 *                         Bebop). No FeeCollector hop exists on this path.
 *   'fee-collector'       The swap is wrapped by the TeraSwapFeeCollector
 *                         contract, which takes the fee on-chain.
 *   'none'                Nothing collects a fee: no partner-fee params AND no
 *                         FeeCollector deployed for the chain (a 'coming-soon'
 *                         chain, activation.ts — its feeCollector is env-null).
 *
 * WHY THIS EXISTS: QuoteBreakdown used to decide with
 *   `FEE_NATIVE_SOURCES.includes(source) || isFeeCollectorActive()`
 * which OR-ed two unrelated conditions. With FEE_NATIVE_SOURCES empty, the 0x
 * row's fee claim rode entirely on the second term — FeeCollector being active
 * — even though 0x is FEE_INCOMPATIBLE and never touches the FeeCollector. The
 * displayed answer was right for a reason that was false. Naming the mechanism
 * makes the claim checkable and makes a future drift a test failure, not a
 * silently-correct coincidence.
 *
 * The order below is the real precedence: partner fee is XOR FeeCollector fee
 * (partner-fee-invariant.test.ts), and every FEE_NATIVE source is also
 * FEE_INCOMPATIBLE, so `usesFeeCollector` is already false for them. Checking
 * native first therefore does not mask a FeeCollector route — it just names the
 * mechanism that is actually collecting.
 */
import { FEE_NATIVE_SOURCES, type AggregatorName } from '@/lib/constants'
import { usesFeeCollector } from '@/lib/api'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'

export type FeeMode = 'native-partner-fee' | 'fee-collector' | 'none'

/** The mechanism that collects TeraSwap's fee for `source` on `chainId`. */
export function feeMode(
  source: AggregatorName,
  chainId: number = DEFAULT_CHAIN_ID,
): FeeMode {
  if (FEE_NATIVE_SOURCES.includes(source)) return 'native-partner-fee'
  if (usesFeeCollector(source, chainId)) return 'fee-collector'
  return 'none'
}

/**
 * True when SOME mechanism collects the fee — i.e. the UI may claim a fee.
 * Chain-aware, unlike the bare `isFeeCollectorActive()` it replaces: on a chain
 * whose FeeCollector is unset (coming-soon, so swaps are not live there anyway)
 * a FeeCollector-routed source now correctly reports no fee instead of
 * inheriting mainnet's answer.
 */
export function isFeeCollected(
  source: AggregatorName,
  chainId: number = DEFAULT_CHAIN_ID,
): boolean {
  return feeMode(source, chainId) !== 'none'
}
