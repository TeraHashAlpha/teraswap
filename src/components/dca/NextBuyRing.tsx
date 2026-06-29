'use client'

/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] NextBuyRing — the signature element: an SVG progress ring (DCA
 * fills N of M) wrapped around the live countdown. Hand-built (no circular-progress component exists
 * repo-wide). The arc smoothly eases on progress change via a CSS transition (reduced-motion safe via
 * `motion-reduce:transition-none`); a small "orbit" dot rides the arc head. Gold by default, recolours
 * to success green when the buy is imminent (<60s) or complete.
 */

import type { ReactNode } from 'react'

const ACCENTS = {
  gold: '#C8B89A',     // brand gold
  success: '#4ADE80',  // imminent / complete
} as const

interface Props {
  /** 0..1 fills-complete fraction. */
  progress: number
  accent?: keyof typeof ACCENTS
  /** Diameter in px. */
  size?: number
  /** Arc thickness in px. */
  stroke?: number
  children?: ReactNode
}

export default function NextBuyRing({ progress, accent = 'gold', size = 220, stroke = 10, children }: Props) {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c * (1 - p)
  const center = size / 2
  // Orbit-dot at the arc head. The arc <circle> parametrises from θ=0 (3 o'clock in SVG-local
  // coords); the wrapping <svg className="-rotate-90"> visually rotates the whole thing so θ=0 lands
  // at 12 o'clock. The dot lives INSIDE that same rotated svg, so it must use the SAME local origin
  // (θ = p·2π) — adding a -π/2 here would double-apply the rotation and trail the head by 90°.
  const angle = p * 2 * Math.PI
  const dotX = center + r * Math.cos(angle)
  const dotY = center + r * Math.sin(angle)
  const color = ACCENTS[accent]

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        {/* Track */}
        <circle cx={center} cy={center} r={r} fill="none" stroke="rgba(245,240,230,0.08)" strokeWidth={stroke} />
        {/* Progress arc */}
        <circle
          data-testid="ring-arc"
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          style={{ strokeDashoffset: offset, transition: 'stroke-dashoffset 0.6s cubic-bezier(0.16,1,0.3,1), stroke 0.4s ease' }}
          className="motion-reduce:transition-none"
        />
        {/* Orbit dot at the arc head */}
        {p > 0 && p < 1 && (
          <circle data-testid="ring-dot" cx={dotX} cy={dotY} r={stroke / 2 + 1} fill={color} className="drop-shadow-[0_0_6px_currentColor]" />
        )}
      </svg>
      {/* Centered content (the countdown) */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  )
}
