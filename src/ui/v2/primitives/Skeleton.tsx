import type { CSSProperties, HTMLAttributes } from 'react'
import { cx } from './cx'
import './primitives.css'

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  width?: number | string
  height?: number | string
}

/** Placeholder block (surface-2 + 1.2s cream shimmer; static under reduced motion). Decorative. */
export function Skeleton({ width, height, className, style, ...rest }: SkeletonProps) {
  const size: CSSProperties = { width, height }
  return <div aria-hidden="true" className={cx('ts-v2-skeleton rounded-v2-control', className)} style={{ ...size, ...style }} {...rest} />
}
