import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cx } from './cx'

export type ButtonVariant = 'primary' | 'secondary'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

const BASE =
  'inline-flex min-h-[46px] items-center justify-center rounded-v2-control border px-5 font-v2-mono text-[13px] font-bold uppercase tracking-[1.5px] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal disabled:cursor-not-allowed'

const VARIANT: Record<ButtonVariant, string> = {
  // cream = primary CTA (README §4 semantics)
  primary: 'border-v2-cream bg-v2-cream text-v2-bg disabled:border-v2-border disabled:bg-v2-surface2 disabled:text-v2-dim',
  secondary: 'border-v2-border bg-v2-surface text-v2-text disabled:bg-v2-surface2 disabled:text-v2-dim',
}

/** Plex Mono 700, tracking 1.5, radius 10, height ≥46 (pack foundation 00). No business logic. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', type = 'button', className, ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={cx(BASE, VARIANT[variant], className)} {...rest} />
})
