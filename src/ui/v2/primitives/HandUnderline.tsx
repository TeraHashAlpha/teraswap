import type { HTMLAttributes } from 'react'
import { cx } from './cx'

export type HandUnderlineProps = HTMLAttributes<HTMLSpanElement>

/**
 * Inline-SVG hand-drawn double stroke under its children (cream). Decorative: hidden from AT.
 *
 * Placement (design review 1, owner: "§2 title underline clips on two-line titles"): the headings that carry it are set at
 * line-height .95–.98, so the box is only ~.98em tall and the glyph baseline sits ~.09em above its bottom. The stroke used to hang
 * `-bottom-1` (4 px) from that box — i.e. through the bottoms of the letters (Q tail, baselines) and into the next line's cap tops.
 * It now hangs .13em below the box and is .2em tall, i.e. it starts ≈ .07em above the box bottom (.91em into a .98em line, just under
 * the baseline) and ends ≈ 1.11em in, so it lives in the free band between this line's baseline and the next line's cap tops
 * (the next caps start at ≈ 1.13–1.17em). Anchored to the BOTTOM so a phrase that wraps is underlined under its LAST line, not its first.
 * Measured at 375 / 1440 (one line) and 320 / 1100 (wrapped) in the feedback.
 */
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
        className="pointer-events-none absolute -bottom-[0.13em] left-0 h-[0.2em] w-full text-v2-cream"
      >
        <path d="M2 8 C 34 3, 66 11, 100 6 S 164 4, 198 8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <path d="M14 12 C 56 8, 98 13, 140 10 S 176 9, 190 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.7" />
      </svg>
    </span>
  )
}
