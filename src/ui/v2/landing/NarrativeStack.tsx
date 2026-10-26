'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { NARRATIVE_PHOTOS, imageSetFor, type NarrativePhotoId } from '../photos/narrative'
import {
  ACTIVE_LINE,
  ACTIVE_THRESHOLDS,
  ENTER_ROOT_MARGIN,
  FLAT_QUERIES,
  MOBILE_QUERY,
  NEAR_ROOT_MARGIN,
  NARRATIVE_SECTIONS,
  REDUCED_MOTION_QUERY,
  photoFor,
  photosFor,
  pickActive,
  type NarrativeMode,
  type NarrativeSectionId,
} from './narrative'
import './narrative.css'

type Section = { id: NarrativeSectionId; el: HTMLElement }

function findSections(): Section[] {
  return NARRATIVE_SECTIONS.flatMap((id) => {
    const el = document.querySelector<HTMLElement>(`[data-ts-narrative="${id}"]`)
    return el ? [{ id, el }] : []
  })
}

/** Both sizes as custom properties: CSS picks 1920 or 1080 by media query, so only one file is ever requested. */
function imageVars(id: NarrativePhotoId): Record<'--nar-d' | '--nar-m', string> {
  const photo = NARRATIVE_PHOTOS[id]
  return { '--nar-d': imageSetFor(photo, 'w1920'), '--nar-m': imageSetFor(photo, 'w1080') }
}

/**
 * [ADR-025] The scroll narrative (round-6 MOTION-SPEC §3–§6), driven entirely by IntersectionObserver — no scroll
 * listener, no snap, no parallax:
 *  - `stack` (default): a fixed stack of photo layers + one constant veil; only a layer's `opacity` animates. The active
 *    layer follows the section crossing the 40 % line and the credit follows it. A layer has no image until its section
 *    is within one viewport.
 *  - `static` (prefers-reduced-motion): no stack. Each section paints its own photo + veil (still lazy), text is shown
 *    at once, the underline is drawn.
 *  - `flat` (reduced transparency / more contrast / forced colours): no photo, no credit, flat `--bg`; nothing is requested.
 * Entrance: a section gets `data-nar-in` once it crosses the line (or is already above it) and is then unobserved, so
 * its `.ts-v2-rv` elements and underline play once. Without JS / IntersectionObserver nothing is hidden.
 */
export function NarrativeStack() {
  const [mode, setMode] = useState<NarrativeMode>('stack')
  const [mobile, setMobile] = useState(false)
  const [active, setActive] = useState<NarrativePhotoId | null>(null)
  const [credited, setCredited] = useState<NarrativePhotoId | null>(null)
  const [loaded, setLoaded] = useState<ReadonlySet<NarrativePhotoId>>(() => new Set())

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || typeof matchMedia === 'undefined') return
    const sections = findSections()
    if (sections.length === 0) return

    const mqMobile = matchMedia(MOBILE_QUERY)
    const mqMotion = matchMedia(REDUCED_MOTION_QUERY)
    const mqFlat = FLAT_QUERIES.map((q) => matchMedia(q))
    const modeNow = (): NarrativeMode => (mqFlat.some((m) => m.matches) ? 'flat' : mqMotion.matches ? 'static' : 'stack')
    let current = modeNow()

    const idOf = new Map<Element, NarrativeSectionId>(sections.map(({ id, el }) => [el, id]))
    const near = new Set<HTMLElement>()
    const entered = new Set<HTMLElement>()

    const load = (photo: NarrativePhotoId) => setLoaded((prev) => (prev.has(photo) ? prev : new Set(prev).add(photo)))
    const paintStatic = ({ id, el }: Section) => {
      for (const [k, v] of Object.entries(imageVars(photoFor(id, mqMobile.matches)))) el.style.setProperty(k, v)
      el.setAttribute('data-nar-static', '')
    }
    const clearStatic = ({ el }: Section) => {
      el.removeAttribute('data-nar-static')
      el.style.removeProperty('--nar-d')
      el.style.removeProperty('--nar-m')
    }
    const show = (el: HTMLElement) => {
      el.setAttribute('data-nar-in', '')
      entered.add(el)
      enter.unobserve(el) // plays once
    }
    /** A section already above the line (deep link, fast jump past it) is shown at once; the IO only catches crossings. */
    const showAbove = () => {
      for (const { el } of sections) if (!entered.has(el) && el.getBoundingClientRect().top <= window.innerHeight * ACTIVE_LINE) show(el)
    }
    const pick = () => {
      showAbove()
      if (current !== 'stack') return
      const rects = sections.map(({ id, el }) => {
        const r = el.getBoundingClientRect()
        return { id, top: r.top, bottom: r.bottom }
      })
      const { photo } = pickActive(rects, window.innerHeight, mqMobile.matches)
      if (photo) {
        load(photo)
        setCredited(photo)
      }
      setActive(photo)
    }
    const applyMode = () => {
      current = modeNow()
      setMode(current)
      setMobile(mqMobile.matches)
      for (const s of sections) if (current === 'static' && near.has(s.el)) paintStatic(s)
      else clearStatic(s)
      if (mqMotion.matches) sections.forEach(({ el }) => show(el))
      if (current === 'stack') {
        for (const s of sections) if (near.has(s.el)) load(photoFor(s.id, mqMobile.matches))
        pick()
      } else {
        setActive(null)
      }
    }

    const nearIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = idOf.get(e.target)
          if (!e.isIntersecting || !id) continue
          const el = e.target as HTMLElement
          near.add(el)
          if (current === 'stack') load(photoFor(id, mqMobile.matches))
          else if (current === 'static') paintStatic({ id, el })
        }
      },
      { rootMargin: NEAR_ROOT_MARGIN },
    )
    const crossingIO = new IntersectionObserver(pick, { threshold: [...ACTIVE_THRESHOLDS] })
    const enter = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) show(e.target as HTMLElement)
      },
      { rootMargin: ENTER_ROOT_MARGIN },
    )

    sections.forEach(({ el }) => {
      el.setAttribute('data-nar-js', '') // from here on `.ts-v2-rv` starts hidden; before, and without JS, it is visible
      nearIO.observe(el)
      crossingIO.observe(el)
      enter.observe(el)
    })
    showAbove()

    const onMobile = () => {
      nearIO.disconnect() // re-observing re-delivers every section's state, so the other map's photos are requested
      sections.forEach(({ el }) => nearIO.observe(el))
      applyMode()
    }
    mqMobile.addEventListener('change', onMobile)
    mqMotion.addEventListener('change', applyMode)
    mqFlat.forEach((m) => m.addEventListener('change', applyMode))
    applyMode()

    return () => {
      mqMobile.removeEventListener('change', onMobile)
      mqMotion.removeEventListener('change', applyMode)
      mqFlat.forEach((m) => m.removeEventListener('change', applyMode))
      nearIO.disconnect()
      crossingIO.disconnect()
      enter.disconnect()
      for (const s of sections) {
        clearStatic(s)
        s.el.removeAttribute('data-nar-js')
        s.el.removeAttribute('data-nar-in')
      }
    }
  }, [])

  if (mode !== 'stack') return null
  const creditName = credited ? NARRATIVE_PHOTOS[credited].photographer : ''
  return (
    <>
      <div className="ts-v2-nar" aria-hidden="true" data-ts-narrative-stack="">
        {photosFor(mobile).map((id) => (
          <div
            key={id}
            className="ts-v2-nar__layer"
            data-photo={id}
            data-active={active === id ? '' : undefined}
            data-loaded={loaded.has(id) ? '' : undefined}
            style={loaded.has(id) ? (imageVars(id) as CSSProperties) : undefined}
          />
        ))}
        <div className="ts-v2-nar__veil" />
      </div>
      <p className="ts-v2-nar-credit" data-active={active ? '' : undefined} data-ts-narrative-credit="">
        <span>
          Photo <em>{creditName}</em> / Pexels
        </span>
      </p>
    </>
  )
}
