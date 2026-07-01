/**
 * [chore/oracle-less-advisory] checkOracleCoverage — order-create pre-check via
 * /api/oracle-coverage. Asks whether the target token has an independent price
 * oracle (Chainlink feed OR DefiLlama coverage) on the active chain, so the DCA
 * panel can render a NEUTRAL heads-up when it does not.
 *
 * Mirrors checkRoute's shape + FAIL-OPEN policy: any HTTP error, malformed body,
 * or network failure returns { hasOracle: true } so a transient probe outage
 * NEVER shows a false "no oracle" note. Only a clean 200 with hasOracle:false
 * surfaces the note. This is informational — it never blocks submission.
 */

export interface OracleCheckParams {
  /** Target token address (for a DCA buy, the bought token = tokenOut). */
  token: string
  /** Active chain the order will execute on. */
  chainId: number
}

export interface OracleCheckResult {
  /** false ⇒ no independent oracle ⇒ render the neutral note. */
  hasOracle: boolean
}

export async function checkOracleCoverage(p: OracleCheckParams): Promise<OracleCheckResult> {
  const qs = new URLSearchParams({ token: p.token, chainId: String(p.chainId) })
  try {
    const res = await fetch(`/api/oracle-coverage?${qs.toString()}`)
    // Any non-2xx → fail OPEN (don't show a note on an infra/ops blip).
    if (!res.ok) return { hasOracle: true }
    const json = await res.json().catch(() => null)
    if (!json || typeof json.hasOracle !== 'boolean') return { hasOracle: true }
    return { hasOracle: json.hasOracle }
  } catch {
    // Network error / fetch unavailable → fail OPEN.
    return { hasOracle: true }
  }
}
