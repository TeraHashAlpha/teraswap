'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { CountdownView } from './positions-model'

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** True while the viewer asks for reduced motion (live: follows the OS setting). SSR / no matchMedia → false. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(REDUCED_MOTION_QUERY)
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

/** v1 CountdownCenter's words and test ids, from a `countdownView` (the clock lives in the card: one 1 s tick per position, as v1). */
export function CountdownText({ view }: { view: CountdownView }) {
  if (view.kind === 'terminal') {
    return (
      <span className="font-v2-display text-[18px] font-bold uppercase tracking-[0.5px] text-v2-muted" data-testid="countdown-terminal">
        {view.text}
      </span>
    )
  }
  return (
    <>
      <span className="font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px] text-v2-muted">{view.label}</span>
      <span
        data-testid="countdown"
        suppressHydrationWarning
        className={view.due ? 'font-v2-mono text-[14px] font-semibold text-v2-green' : 'font-v2-display text-[26px] font-bold leading-none tabular-nums text-v2-text'}
      >
        {view.value}
      </span>
    </>
  )
}

/**
 * [B7] v1 NextBuyRing in the round-7 language: a hairline track, a thin cream arc for fills N of M (green when the buy is imminent or the
 * position complete — v1's accent rule), and the countdown at its centre. No fill, no glow. The arc eases on progress change; under
 * `prefers-reduced-motion` the ring is not drawn at all — the same words stand as static text (owner rule), and tokens.css kills
 * every transition.
 */
export function NextBuyRing({ progress, accent, size = 124, stroke = 3, reduced, children }: {
  progress: number
  accent: 'gold' | 'success'
  size?: number
  stroke?: number
  reduced: boolean
  children: ReactNode
}) {
  if (reduced) {
    return (
      <div className="flex flex-col items-start gap-1 text-left" data-testid="next-buy-static">
        {children}
      </div>
    )
  }
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const center = size / 2
  const angle = p * 2 * Math.PI
  const color = accent === 'success' ? 'var(--green)' : 'var(--cream)'
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} data-testid="next-buy-ring" data-accent={accent}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={center} cy={center} r={r} fill="none" stroke="var(--hairline-rule)" strokeWidth={1} />
        <circle
          data-testid="ring-arc"
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="butt"
          strokeDasharray={c}
          style={{ strokeDashoffset: c * (1 - p), transition: 'stroke-dashoffset var(--t-underline) var(--ease-out), stroke var(--t-base) ease' }}
        />
        {p > 0 && p < 1 && <circle data-testid="ring-dot" cx={center + r * Math.cos(angle)} cy={center + r * Math.sin(angle)} r={stroke + 0.5} fill={color} />}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">{children}</div>
    </div>
  )
}
