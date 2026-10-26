'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { startBackgroundMusic, toggleBackgroundMusic } from '@/lib/sounds'

/**
 * [ADR-025] Background music, v1 semantics on top of the SAME `sounds.ts` engine (same file, volume 0.08, loop):
 *  - ON by default; starts on the visitor's first click, keypress or scroll (browser autoplay rule);
 *  - ♫ toggles ONLY the music (`toggleBackgroundMusic()`); UI sounds are untouched by it.
 * v1 keeps this in a component mounted once at the root; the v2 shell is mounted per page, so the "started" and
 * "on" flags live at module level (they must survive a remount, or every tab change would restart muted music).
 * `startBackgroundMusic()` is idempotent, so running alongside v1's root BackgroundMusic is harmless.
 */
let on = true
let started = false
const subscribers = new Set<() => void>()
const emit = () => subscribers.forEach((fn) => fn())

/** Test seam: forget the module-level flags (a new page load). */
export function resetMusicStateForTests() {
  on = true
  started = false
  emit()
}

export function useBackgroundMusic(): { on: boolean; toggle: () => void } {
  const current = useSyncExternalStore(
    (fn) => {
      subscribers.add(fn)
      return () => void subscribers.delete(fn)
    },
    () => on,
    () => true,
  )

  useEffect(() => {
    if (started) return
    const start = () => {
      if (started) return
      started = true
      startBackgroundMusic()
      cleanup()
    }
    const cleanup = () => {
      document.removeEventListener('click', start)
      document.removeEventListener('keydown', start)
      document.removeEventListener('scroll', start)
    }
    document.addEventListener('click', start)
    document.addEventListener('keydown', start)
    document.addEventListener('scroll', start)
    return cleanup
  }, [])

  const toggle = useCallback(() => {
    on = toggleBackgroundMusic()
    started = true // v1: the toggle counts as the first interaction, so no later auto-start
    emit()
  }, [])

  return { on: current, toggle }
}
