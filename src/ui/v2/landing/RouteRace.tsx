'use client'

import { useEffect, useRef } from 'react'
import { INTEGRATED_DEX_SOURCE_COUNT, INTEGRATED_DEX_SOURCE_NAMES } from '@/config/product-claims'
import { NEAR_ROOT_MARGIN } from './narrative'

/**
 * Round 7 D4 — §2 "route race": one bar per liquidity source, ranked by net output after gas, the winner in cream. It is an
 * ILLUSTRATION and says so (the label is verbatim from the owner's decision). It carries no figures and does not map any
 * venue to any bar: rows are "Route A…", and the sources are listed once, separately, from `product-claims`.
 */
export const RACE_ILLUSTRATIVE_LABEL = 'ILLUSTRATIVE · NOT A LIVE QUOTE'

/** The approved sample's eight bar lengths (% of the winner). Only the SHAPE is data; the count is the claim. */
const CURVE = [100, 95, 91, 87, 83, 74, 62, 48] as const

/** `n` descending bar lengths: the approved curve when n = 8, resampled along it for any other source count. */
export function routeRaceWidths(n: number): number[] {
  const count = Math.max(0, Math.floor(n))
  if (count === CURVE.length) return [...CURVE]
  if (count <= 1) return count === 1 ? [100] : []
  return Array.from({ length: count }, (_, i) => {
    const pos = (i / (count - 1)) * (CURVE.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(CURVE.length - 1, lo + 1)
    return Math.round(CURVE[lo] + (CURVE[hi] - CURVE[lo]) * (pos - lo))
  })
}

const letter = (i: number) => String.fromCharCode(65 + (i % 26))

export function RouteRace() {
  const ref = useRef<HTMLElement>(null)
  const widths = routeRaceWidths(INTEGRATED_DEX_SOURCE_COUNT)

  // Bars grow in on approach: `data-race-js` arms the collapsed state, `data-race-near` releases it (once).
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    el.setAttribute('data-race-js', '')
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        el.setAttribute('data-race-near', '')
        io.disconnect()
      },
      { rootMargin: NEAR_ROOT_MARGIN },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <figure
      ref={ref}
      data-ts-race=""
      role="img"
      aria-label="Illustrative route race: routes ranked by net output after gas; the best route is highlighted. Not a live quote."
      className="ts-v2-race m-0 py-2"
    >
      <figcaption className="ts-v2-rule-b flex flex-col flex-wrap justify-between gap-x-3 gap-y-2 pb-3.5 font-v2-mono text-[11px] font-semibold tracking-[2px] text-v2-muted sm:flex-row">
        <span className="whitespace-nowrap">NET OUTPUT AFTER GAS · {INTEGRATED_DEX_SOURCE_COUNT} SOURCES</span>
        <span data-race-label="" className="whitespace-nowrap text-v2-cream">{RACE_ILLUSTRATIVE_LABEL}</span>
      </figcaption>
      <ol className="m-0 mt-2 list-none p-0">
        {widths.map((w, i) => (
          <li
            key={i}
            data-win={i === 0 ? '' : undefined}
            className="ts-v2-race__row grid h-9 grid-cols-[118px_1fr] items-center gap-2.5 sm:h-[42px] sm:grid-cols-[150px_1fr] sm:gap-4"
          >
            <span className={`font-v2-mono text-[11px] tracking-[1px] sm:text-[12px] sm:tracking-[1.5px] ${i === 0 ? 'text-v2-cream' : 'text-v2-muted'}`}>
              {i === 0 ? `BEST · ROUTE ${letter(i)}` : `ROUTE ${letter(i)}`}
            </span>
            <span className="block">
              <i className="ts-v2-race__bar" style={{ width: `${w}%` }} />
            </span>
          </li>
        ))}
      </ol>
      <p className="ts-v2-rule-t mt-4 pt-3.5 font-v2-mono text-[10px] leading-[1.7] tracking-[1.2px] text-v2-muted">
        SOURCES QUERIED: {INTEGRATED_DEX_SOURCE_NAMES.join(' · ')}
      </p>
    </figure>
  )
}
