'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { NARRATIVE_PHOTOS, imageSetFor, type NarrativePhotoId } from '../photos/narrative'
import {
  ACTIVE_THRESHOLDS,
  MOBILE_QUERY,
  NEAR_ROOT_MARGIN,
  NARRATIVE_SECTIONS,
  photoFor,
  photosFor,
  pickActive,
  type NarrativeSectionId,
} from './narrative'
import './narrative.css'

type Section = { id: NarrativeSectionId; el: HTMLElement }

function findSections(scope: ParentNode): Section[] {
  return NARRATIVE_SECTIONS.flatMap((id) => {
    const el = scope.querySelector<HTMLElement>(`[data-ts-narrative="${id}"]`)
    return el ? [{ id, el }] : []
  })
}

/** Both sizes as custom properties: CSS picks 1920 or 1080 by media query, so only one file is ever requested. */
function layerImages(id: NarrativePhotoId): CSSProperties {
  const photo = NARRATIVE_PHOTOS[id]
  return { '--nar-d': imageSetFor(photo, 'w1920'), '--nar-m': imageSetFor(photo, 'w1080') } as CSSProperties
}

/**
 * [ADR-025] The scroll-narrative photo stack (round-6 MOTION-SPEC §3, §6): one fixed layer per photo plus one constant
 * veil. Only the layers' `opacity` animates (`--t-slow`, `--ease-inout`). The active layer follows the section that
 * crosses the 40 % line; there is no scroll listener — IntersectionObserver only, native scroll, no snap, no parallax.
 * A layer carries no image until its section is within one viewport, so none is requested at scroll 0. The credit
 * follows the active photo. Opaque sections (`.ts-v2-opaque`) cover the stack everywhere outside the narrative.
 */
export function NarrativeStack() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [mobile, setMobile] = useState(false)
  const [active, setActive] = useState<NarrativePhotoId | null>(null)
  const [credited, setCredited] = useState<NarrativePhotoId | null>(null)
  const [loaded, setLoaded] = useState<ReadonlySet<NarrativePhotoId>>(() => new Set())

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || typeof matchMedia === 'undefined') return
    const sections = findSections(rootRef.current?.closest('[data-ts-landing]') ?? document)
    if (sections.length === 0) return
    const mq = matchMedia(MOBILE_QUERY)

    const load = (photo: NarrativePhotoId) => setLoaded((prev) => (prev.has(photo) ? prev : new Set(prev).add(photo)))
    const pick = () => {
      const rects = sections.map(({ id, el }) => {
        const r = el.getBoundingClientRect()
        return { id, top: r.top, bottom: r.bottom }
      })
      const { photo } = pickActive(rects, window.innerHeight, mq.matches)
      if (photo) {
        load(photo)
        setCredited(photo)
      }
      setActive(photo)
    }

    const idOf = new Map<Element, NarrativeSectionId>(sections.map(({ id, el }) => [el, id]))
    const near = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = idOf.get(e.target)
          if (e.isIntersecting && id) load(photoFor(id, mq.matches))
        }
      },
      { rootMargin: NEAR_ROOT_MARGIN },
    )
    const crossing = new IntersectionObserver(pick, { threshold: [...ACTIVE_THRESHOLDS] })
    const observeAll = () => sections.forEach(({ el }) => near.observe(el))
    observeAll()
    sections.forEach(({ el }) => crossing.observe(el))

    const onViewportClass = () => {
      setMobile(mq.matches)
      near.disconnect() // re-observing re-delivers every section's state, so the other map's photos are requested
      observeAll()
      pick()
    }
    setMobile(mq.matches)
    mq.addEventListener('change', onViewportClass)
    pick()

    return () => {
      mq.removeEventListener('change', onViewportClass)
      near.disconnect()
      crossing.disconnect()
    }
  }, [])

  const creditName = credited ? NARRATIVE_PHOTOS[credited].photographer : ''
  return (
    <>
      <div ref={rootRef} className="ts-v2-nar" aria-hidden="true" data-ts-narrative-stack="">
        {photosFor(mobile).map((id) => (
          <div
            key={id}
            className="ts-v2-nar__layer"
            data-photo={id}
            data-active={active === id ? '' : undefined}
            data-loaded={loaded.has(id) ? '' : undefined}
            style={loaded.has(id) ? layerImages(id) : undefined}
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
