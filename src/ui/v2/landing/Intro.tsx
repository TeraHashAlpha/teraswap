'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './intro.css'

/** The four words, in order, with their exact punctuation (owner-approved cut, round 10). */
export const INTRO_WORDS = ['Compare.', 'Verify.', 'Swap.', 'Repeat.'] as const

/** sessionStorage flag: set the first time the intro starts, so it plays once per browser session. */
export const INTRO_SESSION_KEY = 'ts_v2_intro_seen'

// The overlay is decided before the first paint, so the landing never shows and then gets covered.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/**
 * True only for the first call in a browser session. Reduced motion, a missing or throwing sessionStorage (private
 * windows, blocked site data) and a flag already set all mean "no intro": the page is never held back for it.
 */
function claimIntro(): boolean {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
    if (window.sessionStorage.getItem(INTRO_SESSION_KEY) !== null) return false
    window.sessionStorage.setItem(INTRO_SESSION_KEY, '1')
    return true
  } catch {
    return false
  }
}

/** A key press, a wheel turn, a touch drag or any scroll skips the intro. None of them is cancelled: a scroll still scrolls. */
const SKIP_EVENTS = ['keydown', 'wheel', 'touchmove', 'scroll'] as const

/**
 * [round 10] Entry animation on the v2 landing: four words, one at a time, then a curved edge sweeps up and reveals the
 * landing that mounted underneath in the same commit. Overlay only: nothing below it waits for it (the hero's first
 * quote request starts as it does today) and it takes no space.
 *
 * It cannot trap a visitor. The curtain is the only part that takes pointer events, and its CSS animation ends by itself
 * (translated out, `visibility: hidden`, held by fill-mode), so a failing script still ends with a usable page. Under
 * `prefers-reduced-motion` the CSS hides it (tokens.css would otherwise freeze every animation at its first frame) and
 * `claimIntro` never mounts it. The overlay is `aria-hidden` and holds no focusable element.
 */
export function Intro() {
  const [playing, setPlaying] = useState(false)
  const claimed = useRef<boolean | null>(null)

  useIsoLayoutEffect(() => {
    // The ref survives a StrictMode re-run of the effect, so the second pass cannot "un-claim" the first.
    if (claimed.current === null) claimed.current = claimIntro()
    setPlaying(claimed.current)
  }, [])

  useEffect(() => {
    if (!playing) return undefined
    const skip = () => setPlaying(false)
    for (const type of SKIP_EVENTS) window.addEventListener(type, skip, { passive: true })
    return () => {
      for (const type of SKIP_EVENTS) window.removeEventListener(type, skip)
    }
  }, [playing])

  if (!playing) return null
  return (
    <div className="ts-intro" data-ts-intro="" aria-hidden="true">
      <noscript>
        <style>{'.ts-intro{display:none!important}'}</style>
      </noscript>
      {/* A click lands on the curtain itself, so it never reaches a link underneath. */}
      <div
        className="ts-intro__curtain"
        data-ts-intro-curtain=""
        onClick={() => setPlaying(false)}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setPlaying(false)
        }}
      >
        {INTRO_WORDS.map((word, i) => (
          <span key={word} className="ts-intro__word" data-last={i === INTRO_WORDS.length - 1 ? '' : undefined} style={{ ['--i' as string]: i }}>
            {word}
          </span>
        ))}
      </div>
      <svg className="ts-intro__rim" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
        <path d="M0 88.652Q50 111.348 100 88.652" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}
