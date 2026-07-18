/**
 * [SPRINT-9Y] Bundled, inline SVG chain logos (Ethereum, Base, Arbitrum) for the
 * chain selector — never an external fetch. Falls back to a neutral mark for an
 * unknown chain. Decorative (aria-hidden): the adjacent chain name carries the
 * accessible label.
 */
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

// Arbitrum mark — official navy disc with the lighter arrow glyph.
function ArbitrumMark() {
  return (
    <>
      <circle cx="16" cy="16" r="16" fill="#213147" />
      <path fill="#12AAFF" d="M15.06 6.4 8.3 18.03l2.53 4.36 6.76-11.64z" />
      <path fill="#9DCCED" d="m17.6 10.75-3.16 5.45 3.24 5.58 3.15-5.44z" />
      <path fill="#12AAFF" d="M20.02 6.4h-3.19l7.85 13.53h3.2z" />
      <path fill="#213147" d="m11.71 24.5-1.4-2.41H6.9l1.4 2.41z" />
    </>
  )
}

// Unknown chain — neutral ring in the inherited text colour.
function GenericMark() {
  return <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="2" />
}
