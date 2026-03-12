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
        className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-3 bg-[#78350F] px-4 py-2 text-center text-[12px] font-medium text-[#FCD34D] sm:text-[13px]"
      >
        <span>
          TeraSwap is in <strong>beta</strong>. Smart contracts are unaudited. Use at your own risk and never trade more than you can afford to lose.
        </span>
        <button
          onClick={dismiss}
          className="ml-2 flex-shrink-0 rounded px-1.5 py-0.5 text-[#FCD34D]/70 transition-colors hover:bg-[#FCD34D]/10 hover:text-[#FCD34D]"
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
