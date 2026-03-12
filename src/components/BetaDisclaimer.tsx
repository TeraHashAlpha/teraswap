/**
 * Muted footer disclaimer shown at the bottom of each trading panel.
 * Pure presentational — no state, no client directive needed.
 */
export default function BetaDisclaimer() {
  return (
    <p className="mt-3 text-center text-[10px] leading-relaxed text-cream-35 opacity-60">
      This software is experimental and unaudited. It is provided &ldquo;as is&rdquo; with no warranties.
      You are solely responsible for any funds used. Do your own research.
    </p>
  )
}
