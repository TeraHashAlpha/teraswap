import type { HTMLAttributes } from 'react'
import { cx } from './cx'

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Over a photo the panel stays 95% opaque (pack foundation 00: "over photo: 92–98% opaque"). */
  overPhoto?: boolean
}

/**
 * @deprecated Round 7 D2 (no boxes) — use `Surface` (`variant="plain"` for content). Kept under its old name (CLAUDE.md
 * rule #4). Frozen at the pre-Round-7 look (surface + 1px border + 16px radius) until the in-tree callers move to
 * `Surface`, so no screen is left half-unboxed with text on a photo and no scrim; it becomes a `Surface` alias then.
 */
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
