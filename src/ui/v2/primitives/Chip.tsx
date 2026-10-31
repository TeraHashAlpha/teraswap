import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cx } from './cx'
import './primitives.css'

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean
}

/**
 * Round 7 D3 chip / preset (25 · 50 · 100 %, number of buys, interval, expiry, 8/8 SOURCES): mono text, no border, no fill.
 * Selected = cream + underline; the others are muted. A toggle button (`aria-pressed`), hit area ≥ 44 px.
 */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip({ selected = false, type = 'button', className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={selected}
      data-selected={selected ? '' : undefined}
      className={cx(
        'ts-v2-chip inline-flex min-h-[44px] items-center px-2 font-v2-mono text-[12px] font-medium uppercase tracking-[1.5px]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal disabled:cursor-not-allowed disabled:text-v2-dim',
        selected ? 'text-v2-cream' : 'text-v2-muted hover:text-v2-text',
        className,
      )}
      {...rest}
    />
  )
})
