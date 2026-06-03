'use client'

import { useState, useRef, useEffect, useId } from 'react'

/**
 * [SPRINT-9J J3] Accessible info (ⓘ) tooltip.
 *
 * Replaces the bare `<span title="…">` info icons whose native HTML title only
 * appears on a slow hover and never on click or touch — so on mobile (and on any
 * click) they appeared not to open at all. This popover opens on BOTH click and
 * hover, closes on Escape / outside click, and exposes role="tooltip" + aria.
 *
 * Security: `content` is a plain string rendered as a React text child, so it is
 * HTML-escaped — there is no dangerouslySetInnerHTML and therefore no XSS path.
 */
export default function InfoTooltip({
  content,
  label = 'More information',
  className = '',
}: {
  content: string
  label?: string
  className?: string
}) {
  const [pinned, setPinned] = useState(false) // click-toggled (works on touch)
  const [hovered, setHovered] = useState(false) // pointer hover
  const open = pinned || hovered
  const ref = useRef<HTMLSpanElement>(null)
  const tipId = useId()

  useEffect(() => {
    if (!pinned) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPinned(false); setHovered(false) }
    }
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setPinned(false)
        setHovered(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [pinned])

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPinned((p) => !p) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className={`cursor-help leading-none text-cream-35 transition hover:text-cream-65 ${className}`}
      >
        &#9432;
      </button>
      {open && (
        <span
          id={tipId}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-50 mb-1.5 w-52 max-w-[60vw] -translate-x-1/2 rounded-md border border-cream-15 bg-surface-secondary px-2.5 py-1.5 text-left text-[11px] font-normal normal-case leading-snug text-cream-65 shadow-lg shadow-black/30"
        >
          {content}
        </span>
      )}
    </span>
  )
}
