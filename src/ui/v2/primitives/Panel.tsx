import type { HTMLAttributes } from 'react'
import { cx } from './cx'

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Over a photo the panel stays 95% opaque (pack foundation 00: "over photo: 92–98% opaque"). */
  overPhoto?: boolean
}

/** surface + 1px border + 16px radius (README §4). Layout/padding is the caller's via className. */
export function Panel({ overPhoto = false, className, ...rest }: PanelProps) {
  return (
    <div
      className={cx(
        'rounded-v2-card border border-v2-border',
        overPhoto ? 'bg-v2-surface/95' : 'bg-v2-surface',
        className,
      )}
      {...rest}
    />
  )
}
