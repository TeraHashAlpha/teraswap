/**
 * [ADR-025 / B5] v1's client-side swap gates, mirrored 1:1 from SwapBox (the block that computes `anyBlocked`) so the v2 Confirm
 * refuses to execute in exactly the states v1's Swap button is disabled. Pure: every verdict comes from v1's own evaluators
 * (`evaluatePriceGate`, `evaluatePairOracle`, `useDepegCheck`'s result, `estimateSwapUsd`) — nothing here decides a price, an
 * amount or a threshold of its own; the thresholds are v1's constants.
 *
 * The server stays the binding gate (DefiLlama guard, /api/swap 409, on-chain minimumOutput); this is the UX mirror, as in v1.
 */
import { evaluatePriceGate, type PriceGateResult } from '@/lib/price-gate'
import type { PriceCheck } from '@/lib/chainlink'
import type { DepegCheck } from '@/lib/depeg-gate'
import { DEPEG_CONSENT_TOLERANCE, PRICE_IMPACT_CONSENT_TOLERANCE, UNVERIFIED_SWAP_BLOCK_USD, UNVERIFIED_SWAP_WARN_USD } from '@/lib/constants'

/** SwapButton's `blockReason`, same union. */
export type BlockReason = 'price-impact' | 'oracle-stale' | 'extreme' | 'oracle' | 'depeg-consent' | 'depeg-block' | 'depeg-unverified'

export interface GateInput {
  /** `evaluatePairOracle(...)` — the direction-agnostic verdict over both legs' feeds. */
  pairCheck: PriceCheck
  depegCheck: DepegCheck
  /** The deviation the user ticked the price-impact box at (null = not accepted). Per trade, never remembered. */
  acceptedDeviation: number | null
  acceptedDepeg: number | null
  /** `estimateSwapUsd(...).usd` */
  estimatedSwapUsd: number
}

export interface SwapGates {
  priceGate: PriceGateResult
  oracleIntegrityBlocked: boolean
  isExtremeBlock: boolean
  priceImpactConsentNeeded: boolean
  priceImpactAccepted: boolean
  priceImpactBlocking: boolean
  priceGateBlocked: boolean
  depegConsentNeeded: boolean
  depegAccepted: boolean
  depegConsentBlocking: boolean
  depegHardBlocked: boolean
  depegUnverified: boolean
  depegBlocking: boolean
  oracleUnavailable: boolean
  oracleWarnThreshold: boolean
  oracleBlocked: boolean
  anyBlocked: boolean
  blockReason: BlockReason | undefined
}

export function computeGates(i: GateInput): SwapGates {
  const { pairCheck, depegCheck } = i
  // [SPRINT-9J J1] integrity failure / extreme deviation = HARD block; a healthy-oracle deviation = informed consent.
  const priceGate = evaluatePriceGate(pairCheck)
  const oracleIntegrityBlocked = priceGate.mode === 'block'
  const isExtremeBlock = oracleIntegrityBlocked && priceGate.reason === 'extreme-deviation'
  const priceImpactConsentNeeded = priceGate.mode === 'consent'
  // [review F1] consent stays valid only while the live deviation has not worsened past the accepted level (+tolerance).
  const priceImpactAccepted = i.acceptedDeviation != null && pairCheck.deviation <= i.acceptedDeviation + PRICE_IMPACT_CONSENT_TOLERANCE
  const priceImpactBlocking = priceImpactConsentNeeded && !priceImpactAccepted
  const priceGateBlocked = oracleIntegrityBlocked || priceImpactBlocking

  // [SPRINT-9W-oracle / FIX-ORACLE-FAIL-CLOSED] depeg: consent band, hard block, and 'unverified' (could not check → blocks).
  const depegConsentNeeded = depegCheck.mode === 'consent'
  const depegAccepted = i.acceptedDepeg != null && depegCheck.divergence <= i.acceptedDepeg + DEPEG_CONSENT_TOLERANCE
  const depegConsentBlocking = depegConsentNeeded && !depegAccepted
  const depegHardBlocked = depegCheck.mode === 'block'
  const depegUnverified = depegCheck.mode === 'unverified'
  const depegBlocking = depegHardBlocked || depegConsentBlocking || depegUnverified

  // No-oracle value tiers: warn > $1k, block > $10k (v1 constants). An unpriced pair is consent (the review sheet), never a block here.
  const oracleUnavailable = pairCheck.oracleUnavailable
  const oracleWarnThreshold = oracleUnavailable && i.estimatedSwapUsd > UNVERIFIED_SWAP_WARN_USD
  const oracleBlocked = oracleUnavailable && i.estimatedSwapUsd > UNVERIFIED_SWAP_BLOCK_USD
  const anyBlocked = priceGateBlocked || oracleBlocked || depegBlocking

  const blockReason: BlockReason | undefined = depegHardBlocked
    ? 'depeg-block'
    : isExtremeBlock
      ? 'extreme'
      : oracleIntegrityBlocked
        ? 'oracle-stale'
        : depegUnverified
          ? 'depeg-unverified'
          : depegConsentBlocking
            ? 'depeg-consent'
            : priceImpactBlocking
              ? 'price-impact'
              : oracleBlocked
                ? 'oracle'
                : undefined

  return {
    priceGate,
    oracleIntegrityBlocked,
    isExtremeBlock,
    priceImpactConsentNeeded,
    priceImpactAccepted,
    priceImpactBlocking,
    priceGateBlocked,
    depegConsentNeeded,
    depegAccepted,
    depegConsentBlocking,
    depegHardBlocked,
    depegUnverified,
    depegBlocking,
    oracleUnavailable,
    oracleWarnThreshold,
    oracleBlocked,
    anyBlocked,
    blockReason,
  }
}

/**
 * SwapButton's block labels, verbatim. 'price-impact' and 'depeg-consent' are recoverable (the checkbox above) → amber; the rest are
 * hard → red. 'depeg-unverified' is not click-through-able (nothing to accept), so it is hard despite being temporary.
 */
export function blockCopy(reason: BlockReason): { text: string; recoverable: boolean } {
  const text =
    reason === 'price-impact' ? 'Confirm price impact to swap'
    : reason === 'depeg-consent' ? 'Confirm depeg risk to swap'
    : reason === 'depeg-block' ? 'Asset depegged — swap blocked'
    : reason === 'depeg-unverified' ? 'Verifying price — try again shortly'
    : reason === 'oracle' ? 'No oracle — swap blocked'
    : reason === 'extreme' ? 'Price deviation too high — blocked'
    : 'Oracle data unsafe — swap blocked'
  return { text, recoverable: reason === 'price-impact' || reason === 'depeg-consent' }
}
