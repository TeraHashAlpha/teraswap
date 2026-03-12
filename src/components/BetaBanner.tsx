'use client'

import { useState, useEffect, useRef } from 'react'

const STORAGE_KEY = 'teraswap_beta_banner_dismissed'

/**
 * Dismissible beta warning banner — sits above the fixed header.
 * Sets a CSS custom property --beta-banner-h on <html> so the header
 * (and anything else) can offset itself via `top: var(--beta-banner-h, 0px)`.
 */
export default function BetaBanner() {
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setVisible(true)
    }
  }, [])

  // Keep the CSS variable in sync with the banner's height
  useEffect(() => {
    const root = document.documentElement
    if (visible && ref.current) {
      const h = ref.current.offsetHeight
      root.style.setProperty('--beta-banner-h', `${h}px`)
    } else {
      root.style.setProperty('--beta-banner-h', '0px')
    }
    return () => {
      root.style.setProperty('--beta-banner-h', '0px')
    }
  }, [visible])

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1')
    setVisible(false)
  }

  if (!visible) return null

  return (
    <>
      {/* Fixed banner */}
      <div
        ref={ref}
        className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 border-b border-white/[0.06] px-4 py-1.5 text-center text-[11px] text-white/40"
        style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}
      >
        <span>
          Beta version — smart contracts are unaudited. Use with caution.
        </span>
        <button
          onClick={dismiss}
          className="ml-1 flex-shrink-0 rounded px-1 py-0.5 text-white/25 transition-colors hover:text-white/50"
          aria-label="Dismiss beta warning"
        >
          ✕
        </button>
      </div>
      {/* Spacer so page content isn't hidden behind the fixed banner */}
      <div ref={el => {
        if (el && ref.current) el.style.height = `${ref.current.offsetHeight}px`
      }} />
    </>
  )
}
