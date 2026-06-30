/**
 * [chore/dca-resilience] DCA creation guard.
 *
 * A DCA whose schedule cannot finish before the order expires — i.e.
 * interval × dcaTotal > expiry — is mathematically doomed to a partial,
 * eventually-failed order (the keeper can never complete the last buys before
 * the contract rejects the expired order). This pure check lets the create form
 * warn/block at creation and suggest a concrete fix, BEFORE the user signs.
 */

export interface DcaScheduleFit {
  /** false ⇒ the schedule cannot complete before expiry; block/warn. */
  fits: boolean
  /** interval × dcaTotal (seconds the schedule needs to finish all buys). */
  neededSeconds: number
  /** the order's expiry window (seconds from creation). */
  expirySeconds: number
  /** a friendly block message when !fits; null when it fits. */
  reason: string | null
}

const BLOCK_REASON =
  'These buys cannot all complete before the order expires. Increase the expiry, reduce the number of buys, or shorten the interval.'

/**
 * @param p.intervalSeconds seconds between buys
 * @param p.dcaTotal number of buys
 * @param p.expirySeconds order expiry window (seconds from creation)
 */
export function dcaScheduleFitsExpiry({
  intervalSeconds,
  dcaTotal,
  expirySeconds,
}: {
  intervalSeconds: number
  dcaTotal: number
  expirySeconds: number
}): DcaScheduleFit {
  const interval = Number(intervalSeconds)
  const total = Number(dcaTotal)
  const expiry = Number(expirySeconds)

  // Fail OPEN on degenerate / not-yet-entered inputs — never block on garbage;
  // the form's other validations cover incomplete input.
  if (
    !Number.isFinite(interval) || interval <= 0 ||
    !Number.isFinite(total) || total <= 0 ||
    !Number.isFinite(expiry) || expiry <= 0
  ) {
    return { fits: true, neededSeconds: 0, expirySeconds: Number.isFinite(expiry) ? expiry : 0, reason: null }
  }

  const neededSeconds = interval * total
  // Equality fits: the last buy lands right at expiry.
  const fits = neededSeconds <= expiry
  return { fits, neededSeconds, expirySeconds: expiry, reason: fits ? null : BLOCK_REASON }
}
