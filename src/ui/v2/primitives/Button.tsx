import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cx } from './cx'
import './primitives.css'

/**
 * Round 7 D3: ONE solid cream square CTA per screen (`primary`); every other button is text (`text`, hairline underline)
 * or a bare 44 px icon (`icon`). `secondary` is the pre-Round-7 name for what is now `text` (deprecated alias).
 */
export type ButtonVariant = 'primary' | 'text' | 'icon' | 'secondary'
export type ButtonTone = 'default' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** text / icon only: `danger` = red (CANCEL, REVOKE). */
  tone?: ButtonTone
}

const BASE =
  'inline-flex items-center justify-center font-v2-mono uppercase ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal disabled:cursor-not-allowed'

const VARIANT: Record<Exclude<ButtonVariant, 'secondary'>, string> = {
  // the one filled shape: solid cream, square (README §4 "cream = primary CTA")
  primary:
    'min-h-[46px] rounded-[var(--radius-cta)] bg-v2-cream px-5 text-[13px] font-bold tracking-[1.5px] text-v2-bg ' +
    'disabled:bg-v2-surface2 disabled:text-v2-dim',
  text: 'ts-v2-underline min-h-[44px] bg-transparent px-1 text-[12px] font-medium tracking-[1.5px] disabled:text-v2-dim',
  icon: 'h-11 min-h-[44px] w-11 min-w-[44px] bg-transparent text-v2-cream hover:text-v2-text disabled:text-v2-dim',
}

const TONE: Record<ButtonTone, string> = { default: 'text-v2-cream', danger: 'text-v2-red' }

/** Plex Mono, tracking 1.5, hit area ≥ 44 px (≥ 46 for the CTA). No business logic. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', tone = 'default', type = 'button', className, ...rest },
  ref,
) {
  const v = variant === 'secondary' ? 'text' : variant
  return (
    <button
      ref={ref}
      type={type}
      data-variant={v}
      data-tone={v === 'primary' ? undefined : tone}
      className={cx(BASE, VARIANT[v], v !== 'primary' && TONE[tone], className)}
      {...rest}
    />
  )
})
