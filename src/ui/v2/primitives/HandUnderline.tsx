import type { HTMLAttributes } from 'react'
import { cx } from './cx'

export type HandUnderlineProps = HTMLAttributes<HTMLSpanElement>

/** Inline-SVG hand-drawn double stroke under its children (cream). Decorative: hidden from AT. */
export function HandUnderline({ className, children, ...rest }: HandUnderlineProps) {
  return (
    <span className={cx('relative inline-block', className)} {...rest}>
      {children}
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 200 14"
        preserveAspectRatio="none"
        fill="none"
        className="pointer-events-none absolute -bottom-1 left-0 h-[0.3em] w-full text-v2-cream"
      >
        <path d="M2 8 C 34 3, 66 11, 100 6 S 164 4, 198 8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <path d="M14 12 C 56 8, 98 13, 140 10 S 176 9, 190 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.7" />
      </svg>
    </span>
  )
}
