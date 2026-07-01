/**
 * [chore/oracle-less-advisory] Pure oracle-coverage decision for the creation-time
 * "no price oracle" note.
 *
 * A token is treated as ORACLE-LESS (→ show the neutral note) only when BOTH:
 *   1. it has no Chainlink feed on the active chain (direct or composed), AND
 *   2. DefiLlama definitively returns no usable price for it on that chain.
 *
 * DefiLlama coverage is a tri-state:
 *   - 'covered' → a usable price exists → has oracle.
 *   - 'none'    → the probe responded but has no usable price → definitively uncovered.
 *   - 'unknown' → the probe itself failed (network/timeout) → we can't tell, so we
 *                 FAIL OPEN (treat as covered) rather than show a false note.
 *
 * This never blocks order creation — it only decides whether to render an
 * informational heads-up.
 */

export type DefiLlamaCoverage = 'covered' | 'none' | 'unknown'

export interface OracleCoverageResult {
  /** false ⇒ oracle-less ⇒ render the neutral note. */
  hasOracle: boolean
  hasChainlink: boolean
  defillama: DefiLlamaCoverage
}

export function resolveOracleCoverage(
  hasChainlink: boolean,
  defillama: DefiLlamaCoverage,
): OracleCoverageResult {
  // Oracle-less only when there is NO Chainlink feed AND DefiLlama definitively
  // has no price. Any other combination (Chainlink present, DefiLlama covered, or
  // a failed/unknown probe) → treat as covered → no note.
  const hasOracle = hasChainlink || defillama === 'covered' || defillama === 'unknown'
  return { hasOracle, hasChainlink, defillama }
}
