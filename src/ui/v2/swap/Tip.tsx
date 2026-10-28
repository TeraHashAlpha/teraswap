'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Surface } from '../primitives'

/**
 * Round 7 FUNCTIONAL-CONTAINERS item 15: the (i) tooltip keeps a solid surface, minimal size, no border. Same behaviour as
 * v1's InfoTooltip (opens on hover, focus and click/tap; Escape / outside click closes; `role="tooltip"`); `content` is a
 * plain string child, so it is escaped.
 */
export function Tip({ content, label = 'More information' }: { content: string; label?: string }) {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const open = pinned || hovered
  const ref = useRef<HTMLSpanElement>(null)
  const id = useId()

  useEffect(() => {
    if (!pinned) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false)
        setHovered(false)
      }
    }
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setPinned(false)
        setHovered(false)
      }
    }
    document.addEventListener('keydown', key)
    document.addEventListener('mousedown', down)
    return () => {
      document.removeEventListener('keydown', key)
      document.removeEventListener('mousedown', down)
    }
  }, [pinned])

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setPinned((p) => !p)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className="ts-swap-tipbtn cursor-help text-v2-muted hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
      >
        <span aria-hidden="true">&#9432;</span>
      </button>
      {open ? (
        <Surface
          id={id}
          role="tooltip"
          variant="popover"
          bare
          className="absolute bottom-full left-1/2 z-30 mb-2 w-56 max-w-[70vw] -translate-x-1/2 px-3 py-2 text-left font-v2-sans text-[12px] font-normal normal-case leading-snug text-v2-text"
        >
          {content}
        </Surface>
      ) : null}
    </span>
  )
}
