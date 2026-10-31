import type { CSSProperties, HTMLAttributes } from 'react'
import { cx } from './cx'
import './primitives.css'

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  width?: number | string
  height?: number | string
}

/** Placeholder bar (hairline cream + 1.2s sweep; static under reduced motion). Decorative. Unboxed: square, no border (Round 7). */
export function Skeleton({ width, height, className, style, ...rest }: SkeletonProps) {
  const size: CSSProperties = { width, height }
  return <div aria-hidden="true" className={cx('ts-v2-skeleton', className)} style={{ ...size, ...style }} {...rest} />
}
