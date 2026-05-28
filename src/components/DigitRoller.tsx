'use client'

/**
 * [P191] DigitRoller — slot-machine / odometer animation for the swap
 * output amount. When a new quote arrives, each digit rolls vertically to
 * its new value instead of snapping. Inspired by Matcha Meta, but built
 * declaratively on Framer Motion spring physics (GPU-composited, no rAF
 * loop, no manual DOM mutation).
 *
 * The component consumes an already-formatted string from `formatDisplay()`
 * (e.g. "1 975.6553") — it never reformats the number itself.
 */

import { memo, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'

/**
 * Default line-height (px) matching `text-2xl`. Exported for tests.
 * The component measures the real line-height from the DOM at mount and
 * falls back to this constant (SSR / first paint / JSDOM where
 * `getComputedStyle().lineHeight` is empty).
 */
export const LINE_HEIGHT_PX = 32

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const

function isDigitChar(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

interface DigitColumnProps {
  digit: number
  lineHeight: number
  /** 0-based index of this digit among all digits, counted from the LEFT. */
  columnIndex: number
  totalDigits: number
  reduce: boolean
}

/**
 * A single digit position. Stacks 0–9 vertically inside a 1ch-wide,
 * clipped column and animates the stack's `y` so the active digit sits in
 * the viewport. Memoised — only re-renders when `digit`/`lineHeight` change.
 */
const DigitColumn = memo(function DigitColumn({
  digit,
  lineHeight,
  columnIndex,
  totalDigits,
  reduce,
}: DigitColumnProps) {
  // Right-most digits settle slightly before left-most (real-odometer feel).
  const delay = (totalDigits - columnIndex - 1) * 0.02

  const rollTransition = reduce
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 180, damping: 22, mass: 0.8, delay }

  // Enter (value grows) / exit (value shrinks) fade. Disabled under
  // reduced-motion so columns appear/disappear instantly.
  const enterExit = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 16 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -16 },
      }

  return (
    <motion.span
      data-testid="digit-column"
      className="relative inline-block w-[1ch] overflow-y-clip text-center align-baseline"
      style={{ height: lineHeight }}
      {...enterExit}
      transition={{ duration: reduce ? 0 : 0.2 }}
    >
      {/* Hidden spacer reserves intrinsic width/height — never animated. */}
      <span aria-hidden className="invisible">
        0
      </span>
      <motion.span
        className="absolute inset-x-0 top-0 block"
        initial={false}
        animate={{ y: -digit * lineHeight }}
        transition={rollTransition}
      >
        {DIGITS.map((d) => (
          <span
            key={d}
            className="flex items-center justify-center"
            style={{ height: lineHeight }}
          >
            {d}
          </span>
        ))}
      </motion.span>
    </motion.span>
  )
})

interface DigitRollerProps {
  /** Formatted value string, e.g. "1 975.6553" or "0.0012". */
  value: string
  /** Static prefix rendered before the roller (e.g. "~"). Not rolled. */
  prefix?: string
  /** CSS class for the outer wrapper. */
  className?: string
}

function DigitRoller({ value, prefix, className }: DigitRollerProps) {
  const reduce = useReducedMotion() ?? false
  const containerRef = useRef<HTMLSpanElement>(null)
  const [lineHeight, setLineHeight] = useState(LINE_HEIGHT_PX)

  // [P191-G] Derive the real line-height from the DOM so the animation stays
  // aligned if `text-2xl` is customised. Falls back to LINE_HEIGHT_PX.
  useEffect(() => {
    if (containerRef.current) {
      const computed = parseFloat(getComputedStyle(containerRef.current).lineHeight)
      if (!isNaN(computed) && computed > 0) setLineHeight(computed)
    }
  }, [])

  // Loading / empty placeholder — mirrors the old `animate-pulse` behaviour.
  if (value === undefined || value === null || value === '') {
    return (
      <span ref={containerRef} className={className}>
        {prefix}
        <span className="inline-block animate-pulse text-cream-35">...</span>
      </span>
    )
  }

  // safeBigInt failure fallback — render the dash statically, no rollers.
  if (value === '—') {
    return (
      <span ref={containerRef} className={`tabular-nums ${className ?? ''}`}>
        {prefix}
        <span>{value}</span>
      </span>
    )
  }

  const chars = value.split('')
  const totalDigits = chars.reduce((n, ch) => (isDigitChar(ch) ? n + 1 : n), 0)

  // Pre-pass: 0-based left-to-right index among digit columns only, used for
  // the odometer stagger. Computed before render so we never reassign during
  // the JSX map (keeps the React-compiler lint happy).
  const digitIndexAt: number[] = []
  let seen = 0
  for (const ch of chars) {
    digitIndexAt.push(seen)
    if (isDigitChar(ch)) seen += 1
  }

  return (
    <span ref={containerRef} className={`tabular-nums ${className ?? ''}`}>
      {prefix && <span>{prefix}</span>}
      <AnimatePresence initial={false}>
        {chars.map((ch, i) => {
          // Right-anchored key keeps digits decimal-aligned when the value
          // grows or shrinks (odometer behaviour, not left-shift).
          const key = chars.length - 1 - i
          if (!isDigitChar(ch)) {
            return (
              <span key={`sep-${key}`} data-testid="digit-separator">
                {ch}
              </span>
            )
          }
          return (
            <DigitColumn
              key={`d-${key}`}
              digit={Number(ch)}
              lineHeight={lineHeight}
              columnIndex={digitIndexAt[i]}
              totalDigits={totalDigits}
              reduce={reduce}
            />
          )
        })}
      </AnimatePresence>
    </span>
  )
}

export default memo(DigitRoller)
