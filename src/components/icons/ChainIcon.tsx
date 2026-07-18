/**
 * [SPRINT-9Y] Bundled, inline SVG chain logos (Ethereum, Base, Arbitrum) for the
 * chain selector — never an external fetch. Falls back to a neutral mark for an
 * unknown chain. Decorative (aria-hidden): the adjacent chain name carries the
 * accessible label.
 */
import { useId } from 'react'

interface Props {
  chainId: number
  className?: string
}

export default function ChainIcon({ chainId, className = 'h-4 w-4' }: Props) {
  return (
    <svg
      data-testid={`chain-icon-${chainId}`}
      className={className}
      viewBox="0 0 32 32"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      {chainId === 1 ? <EthereumMark /> : chainId === 8453 ? <BaseMark /> : chainId === 42161 ? <ArbitrumMark /> : <GenericMark />}
    </svg>
  )
}

// Ethereum coin mark (periwinkle disc + faceted diamond).
function EthereumMark() {
  return (
    <>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#FFF" fillRule="nonzero">
        <path fillOpacity="0.602" d="M16.498 4v8.87l7.497 3.35z" />
        <path d="M16.498 4 9 16.22l7.498-3.35z" />
        <path fillOpacity="0.602" d="M16.498 21.968v6.027L24 17.616z" />
        <path d="M16.498 27.995v-6.028L9 17.616z" />
        <path fillOpacity="0.2" d="m16.498 20.573 7.497-4.353-7.497-3.348z" />
        <path fillOpacity="0.602" d="M9 16.22l7.498 4.353v-7.701z" />
      </g>
    </>
  )
}

// Base mark — official blue disc with the negative-space bar; the white circle
// behind makes the bar read white on the dark header.
function BaseMark() {
  return (
    <>
      <circle cx="16" cy="16" r="16" fill="#FFFFFF" />
      <path
        fill="#0052FF"
        d="M15.9994 32C24.8369 32 32 24.8366 32 16C32 7.16344 24.8369 0 15.9994 0C7.61673 0 0.745683 6.4452 0 14.6361H21.1718V17.3639H0C0.745683 25.5548 7.61673 32 15.9994 32Z"
      />
    </>
  )
}

// Arbitrum mark — official navy disc + the two-part arrow glyph (the white
// diagonal bar + the blue chevron). Geometry is Arbitrum's real official
// artwork — the exact path data ecosystem tooling ships (@rainbow-me/
// rainbowkit's bundled per-chain network-switcher icon for Arbitrum),
// uniformly rescaled (not freehanded) from its source 40x40/r17.5 circle onto
// our 32x32/r16 full-bleed circle, then svgo-optimized. Clipped to our circle
// (the source paths overflow a plain square bounding box) with a per-instance
// clipPath id (useId) so multiple renders on one page never collide.
function ArbitrumMark() {
  const clipId = useId()
  return (
    <>
      <defs>
        <clipPath id={clipId}>
          <circle cx="16" cy="16" r="16" />
        </clipPath>
      </defs>
      <circle cx="16" cy="16" r="16" fill="#213147" />
      <g clipPath={`url(#${clipId})`}>
        <path fill="#28a0f0" d="m22.284 31.718-6.172-9.705 3.458-5.866L27.5 28.651zm6.631-4.024 3.174-5.29-8.446-13.187-3.017 5.116z" />
        <path
          fill="#fff"
          d="m-1.81 34.574-4.011-2.308-.305-1.089L7.833 9.495c.952-1.556 3.03-2.057 4.957-2.03l2.263.06-16.864 27.049Zm24.557-27.05-5.963.023-21.721 35.882 4.48 3.2 5.813-9.69 1.282-2.174z"
        />
      </g>
    </>
  )
}

// Unknown chain — neutral ring in the inherited text colour.
function GenericMark() {
  return <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="2" />
}
