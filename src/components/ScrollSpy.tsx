'use client'

/* [P88] Fixed left-side dot navigation for the landing page.
 *
 * IntersectionObserver watches each section id; the active dot is the
 * topmost intersecting section (rootMargin biased to the upper part of
 * the viewport so the highlight kicks in as a section enters from below).
 * Hover reveals a small label to the right. Click smooth-scrolls to the
 * section. Hidden below the `lg` breakpoint — desktop wayfinding only.
 */

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Section {
  id: string
  label: string
}

const SECTIONS: Section[] = [
  { id: 'hero', label: 'HERO' },
  { id: 'performance', label: 'ENGINE' },
  { id: 'why-teraswap', label: 'EDGE' },
  { id: 'security', label: 'SECURITY' },
  { id: 'experience', label: 'DESIGN' },
  { id: 'features', label: 'FEATURES' },
]

const PREFERS_REDUCED =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function ScrollSpy() {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id)
  const [hoverId, setHoverId] = useState<string | null>(null)

  useEffect(() => {
    // Find elements once; if any section is missing the observer just
    // ignores it silently.
    const elements = SECTIONS
      .map(s => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null)

    if (elements.length === 0) return

    // Track which sections are currently intersecting; pick the topmost.
    const intersecting = new Map<string, number>() // id → top position
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            intersecting.set(entry.target.id, entry.boundingClientRect.top)
          } else {
            intersecting.delete(entry.target.id)
          }
        }
        if (intersecting.size === 0) return
        // Topmost intersecting section wins.
        let topId = ''
        let topY = Number.POSITIVE_INFINITY
        for (const [id, y] of intersecting) {
          if (y < topY) {
            topY = y
            topId = id
          }
        }
        if (topId) setActiveId(topId)
      },
      {
        threshold: 0.2,
        rootMargin: '-20% 0px -60% 0px',
      },
    )

    for (const el of elements) observer.observe(el)
    return () => observer.disconnect()
  }, [])

  function handleClick(id: string) {
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ behavior: PREFERS_REDUCED ? 'auto' : 'smooth' })
  }

  const activeIndex = Math.max(0, SECTIONS.findIndex(s => s.id === activeId))
  // Progress segment height = active index / (count - 1) of the total
  // line height. Total line = (gap-4 * 5 dots between) + 6 dot heights.
  const progressPct = (activeIndex / (SECTIONS.length - 1)) * 100

  return (
    <nav
      aria-label="Page sections"
      className="pointer-events-none fixed left-6 top-1/2 z-20 hidden -translate-y-1/2 lg:flex"
    >
      <ol className="pointer-events-auto relative flex flex-col gap-4">
        {/* Thin connector line — sits behind the dots */}
        <div className="pointer-events-none absolute left-1/2 top-1 bottom-1 w-px -translate-x-1/2 bg-cream-08" />
        {/* Gold progress segment — top to current dot */}
        <div
          className="pointer-events-none absolute left-1/2 top-1 w-px -translate-x-1/2 bg-[#C8B89A] transition-[height] duration-300"
          style={{ height: `calc(${progressPct}% - 0px)` }}
          aria-hidden="true"
        />
        {SECTIONS.map((section) => {
          const isActive = section.id === activeId
          const isHover = section.id === hoverId
          return (
            <li
              key={section.id}
              className="relative flex items-center"
              onMouseEnter={() => setHoverId(section.id)}
              onMouseLeave={() => setHoverId((h) => (h === section.id ? null : h))}
            >
              <button
                type="button"
                onClick={() => handleClick(section.id)}
                aria-label={`Scroll to ${section.label} section`}
                aria-current={isActive ? 'true' : undefined}
                className={`relative z-10 block rounded-full border transition-all duration-200 ${
                  isActive
                    ? 'h-2 w-2 border-[#C8B89A] bg-[#C8B89A]'
                    : 'h-1.5 w-1.5 border-[rgba(200,184,154,0.35)] bg-transparent hover:border-[#C8B89A]'
                }`}
                style={
                  isActive
                    ? { boxShadow: '0 0 8px rgba(200,184,154,0.4)' }
                    : undefined
                }
              />
              <AnimatePresence>
                {isHover && (
                  <motion.span
                    initial={PREFERS_REDUCED ? false : { opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={PREFERS_REDUCED ? undefined : { opacity: 0, x: -4 }}
                    transition={{ duration: 0.15 }}
                    className="pointer-events-none absolute left-5 whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.12em] text-cream-75"
                  >
                    {section.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
