'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker for PWA functionality.
 * Must be a client component — service workers only run in the browser.
 */
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      process.env.NODE_ENV === 'production'
    ) {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[TeraSwap] SW registration failed:', err)
      })
    }
  }, [])

  return null
}
