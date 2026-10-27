import { forwardRef, type InputHTMLAttributes } from 'react'
import { cx } from './cx'
import './primitives.css'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Error state: the underline turns red (and `aria-invalid` is set). */
  invalid?: boolean
  /** `amount` = the large mono number field (Sell / Receive / DCA "Total to spend"); `field` = search and text. */
  scale?: 'field' | 'amount'
}

/**
 * Round 7 D3 underline-only input: transparent, no box, no radius. The 1 px underline is the --hairline-ring cream (≥ 3:1
 * on --bg, see primitives-contrast.test.ts), turns cream on focus and red on error (error wins). Needs an accessible name
 * from the caller (a `<label>` or `aria-label`).
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid = false, scale = 'field', className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid ? true : undefined}
      data-scale={scale}
      className={cx('ts-v2-input w-full bg-transparent text-v2-text placeholder:text-v2-dim', scale === 'amount' ? 'font-v2-mono text-[28px]' : 'text-[15px]', className)}
      {...rest}
    />
  )
})
