import type { HTMLAttributes } from 'react'
import { cx } from './cx'
import './primitives.css'

/**
 * Round 7 D2/D3 — the only four surfaces the v2 language has. Content (`plain`) has NO fill, border or radius: it sits on
 * the photo behind a local scrim and is separated from its neighbours by one cream hairline. The other three are the
 * functional overlays FUNCTIONAL-CONTAINERS.md keeps, in their minimal form: solid, square, hairline only.
 *
 *   plain    no fill · no border · no radius              (cards, rows, panels, summaries — formerly `Panel`)
 *   sheet    solid --bg · top hairline (or left, a drawer)  (modals — full-bleed — and the help drawer)
 *   strip    solid --bg · bottom hairline, or a 2 px accent  (mobile header/tab strip, toasts, the notice banner)
 *   popover  solid --surface · 1 px hairline · no shadow       (dropdown menu; `bare` = no hairline, for a tooltip)
 */
export type SurfaceVariant = 'plain' | 'sheet' | 'strip' | 'popover'
export type SurfaceEdge = 'top' | 'bottom' | 'left' | 'both'
export type SurfaceAccent = 'cream' | 'teal' | 'red' | 'green' | 'amber'

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SurfaceVariant
  /** Which side carries the hairline. Default: plain none · sheet top · strip bottom. `both` = top + bottom (stats). */
  edge?: SurfaceEdge
  /** strip only: a 2 px left accent in the status colour instead of the bottom hairline (toasts, banner). */
  accent?: SurfaceAccent
  /** popover only: drop the hairline (the tooltip). */
  bare?: boolean
}

const EDGE: Record<SurfaceEdge, string> = {
  top: 'ts-v2-rule-t',
  bottom: 'ts-v2-rule-b',
  left: 'ts-v2-rule-l',
  both: 'ts-v2-rule-t ts-v2-rule-b',
}

const ACCENT: Record<SurfaceAccent, string> = {
  cream: 'border-v2-cream',
  teal: 'border-v2-teal',
  red: 'border-v2-red',
  green: 'border-v2-green',
  amber: 'border-v2-amber',
}

/** No radius anywhere (square is the language). Layout and padding are the caller's, via className. */
export function Surface({ variant = 'plain', edge, accent, bare = false, className, ...rest }: SurfaceProps) {
  let look: string
  if (variant === 'sheet') look = cx('bg-v2-bg', EDGE[edge ?? 'top'])
  else if (variant === 'strip') look = cx('bg-v2-bg', accent ? cx('border-l-2', ACCENT[accent]) : EDGE[edge ?? 'bottom'])
  else if (variant === 'popover') look = cx('bg-v2-surface', !bare && 'border border-[color:var(--hairline)]')
  else look = edge ? EDGE[edge] : ''
  return <div data-surface={variant} className={cx(look, className)} {...rest} />
}
