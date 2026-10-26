import type { HTMLAttributes } from 'react'
import { cx } from './cx'

export type EyebrowLabelProps = HTMLAttributes<HTMLSpanElement>

/** Cream bar + Plex Mono uppercase label (pack: "numbers, addresses, eyebrows" are mono). */
export function EyebrowLabel({ className, ...rest }: EyebrowLabelProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center border-l-2 border-v2-cream pl-2 font-v2-mono text-[11px] font-bold uppercase tracking-[2px] text-v2-cream',
        className,
      )}
      {...rest}
    />
  )
}
