'use client'

/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] CountdownCenter — the live next-buy countdown shown inside the ring.
 *
 * Ticks once per second and recomputes the remaining time from the target each tick (no decrement →
 * no drift, no jank). Once due it shows "Executing soon…" (the keeper runs within ~30s) and stops the
 * interval. With no target (terminal state) it renders a static label and never starts a timer. It is
 * PURE display — it never fetches, so the 1s cadence cannot hammer the API.
 */

import { useState, useEffect, useRef } from 'react'
import { formatHMS, isDue } from '@/lib/order-engine/dca-countdown'

interface Props {
  /** Target timestamp (ms) of the next buy, or null for a terminal state (no countdown). */
  targetMs: number | null
  /** Static label when there's no countdown (e.g. "Completed", "Cancelled"). */
  terminalLabel?: string
  /** Small caption above the time. */
  label?: string
}

export default function CountdownCenter({ targetMs, terminalLabel, label = 'Next buy in' }: Props) {
  const [now, setNow] = useState(() => Date.now())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (targetMs == null) return
    const tick = () => {
      const t = Date.now()
      setNow(t)
      // Once the target passes there is nothing left to count — stop ticking.
      if (t >= targetMs && intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
    tick()
    intervalRef.current = setInterval(tick, 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [targetMs])

  if (targetMs == null) {
    return (
      <span className="font-display text-lg font-semibold text-cream-50" data-testid="countdown-terminal">
        {terminalLabel ?? '—'}
      </span>
    )
  }

  const remaining = targetMs - now
  const due = isDue(remaining)

  return (
    <>
      <span className="text-[10px] font-medium uppercase tracking-[2px] text-cream-35">
        {due ? 'Buying now' : label}
      </span>
      <span
        data-testid="countdown"
        suppressHydrationWarning
        className={`font-display tabular-nums leading-none ${
          due ? 'text-base font-semibold text-success' : 'text-[28px] font-bold text-cream'
        }`}
      >
        {due ? 'Executing soon…' : formatHMS(remaining)}
      </span>
    </>
  )
}
