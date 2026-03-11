'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { startBackgroundMusic, stopBackgroundMusic, toggleBackgroundMusic } from '@/lib/sounds'

/**
 * Background music controller — starts ambient music on first user interaction.
 * Shows a small toggle button fixed at the bottom-left corner.
 */
export default function BackgroundMusic() {
  const [enabled, setEnabled] = useState(true)
  const startedRef = useRef(false)

  // Start music on first user interaction (browser autoplay policy)
  useEffect(() => {
    const start = () => {
      if (startedRef.current) return
      startedRef.current = true
      startBackgroundMusic()
      // Clean up listeners after first successful start
      document.removeEventListener('click', start)
      document.removeEventListener('keydown', start)
      document.removeEventListener('scroll', start)
    }

    if (!startedRef.current) {
      document.addEventListener('click', start)
      document.addEventListener('keydown', start)
      document.addEventListener('scroll', start)
    }

    return () => {
      document.removeEventListener('click', start)
      document.removeEventListener('keydown', start)
      document.removeEventListener('scroll', start)
    }
    // Empty deps — only run once on mount, never re-run (no cleanup that stops music)
  }, [])

  // Stop music only when the component fully unmounts
  useEffect(() => {
    return () => { stopBackgroundMusic() }
  }, [])

  const handleToggle = useCallback(() => {
    const nowEnabled = toggleBackgroundMusic()
    setEnabled(nowEnabled)
    startedRef.current = true
  }, [])

  return (
    <button
      onClick={handleToggle}
      className="fixed bottom-4 left-4 z-50 flex h-8 w-8 items-center justify-center rounded-full border border-cream-08 bg-surface-secondary/80 backdrop-blur-sm text-cream-50 hover:text-cream-90 hover:border-cream-gold/40 transition-all text-sm"
      title={enabled ? 'Mute background music' : 'Unmute background music'}
      aria-label={enabled ? 'Mute background music' : 'Unmute background music'}
    >
      {enabled ? '♫' : '✕'}
    </button>
  )
}
