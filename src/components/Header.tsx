'use client'

import { useEffect, useState, useCallback } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import ThemeToggle from './ThemeToggle'
import WalletModal from './WalletModal'

interface Props {
  onLogoClick?: () => void
  showNav?: boolean
  onDocsClick?: () => void
}

const NAV_LINKS = [
  { label: 'Performance', id: 'performance' },
  { label: 'Security', id: 'security' },
  { label: 'Experience', id: 'experience' },
  { label: 'Features', id: 'features' },
]

export default function Header({ onLogoClick, showNav = false, onDocsClick }: Props) {
  const [scrolled, setScrolled] = useState(false)
  const [walletOpen, setWalletOpen] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const toggleWallet = useCallback(() => setWalletOpen(prev => !prev), [])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 flex items-center justify-between px-3 py-3 transition-all duration-500 sm:px-4 sm:py-4 md:px-8 ${
        scrolled
          ? 'backdrop-blur-2xl border-b border-cream-08'
          : 'bg-transparent border-b border-transparent'
      }`}
      style={scrolled ? { backgroundColor: 'var(--header-blur)' } : undefined}
    >
      {/* Logo */}
      <div
        className="flex cursor-pointer flex-col transition-opacity hover:opacity-80"
        onClick={onLogoClick}
      >
        <span className="font-display text-xl font-extrabold uppercase tracking-[4px] text-cream">
          TERASWAP
        </span>
        <span className="mt-[-2px] text-[11px] font-medium tracking-[0.12em] text-cream-50">
          Meta-Aggregator
        </span>
      </div>

      {/* Center nav links (landing page only) */}
      {showNav && (
        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <button
              key={link.id}
              onClick={() => scrollTo(link.id)}
              className="text-[13px] font-medium text-cream-50 transition-colors hover:text-cream"
            >
              {link.label}
            </button>
          ))}
          <button
            onClick={onDocsClick}
            className="text-[13px] font-medium text-cream-50 transition-colors hover:text-cream"
          >
            Docs
          </button>
        </nav>
      )}

      {/* Mobile menu button (landing only) */}
      {showNav && (
        <button
          onClick={() => setMobileMenu(!mobileMenu)}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-cream-15 text-cream-65 transition hover:text-cream md:hidden"
          aria-label="Menu"
        >
          {mobileMenu ? '✕' : '☰'}
        </button>
      )}

      {/* Mobile nav dropdown */}
      {showNav && mobileMenu && (
        <div className="absolute left-0 right-0 top-full border-b border-cream-08 p-4 backdrop-blur-2xl md:hidden" style={{ backgroundColor: 'var(--header-blur)' }}>
          <nav className="flex flex-col gap-3">
            {NAV_LINKS.map((link) => (
              <button
                key={link.id}
                onClick={() => { scrollTo(link.id); setMobileMenu(false) }}
                className="text-left text-sm font-medium text-cream-65 transition-colors hover:text-cream"
              >
                {link.label}
              </button>
            ))}
            <button
              onClick={() => { onDocsClick?.(); setMobileMenu(false) }}
              className="text-left text-sm font-medium text-cream-65 transition-colors hover:text-cream"
            >
              Docs
            </button>
          </nav>
        </div>
      )}

      {/* Right side */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Theme toggle */}
        <ThemeToggle />

        {/* Ethereum network indicator */}
        <div className="hidden items-center gap-1.5 rounded-full border border-cream-15 px-3 py-1.5 text-xs font-medium text-cream-65 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-slow" />
          Ethereum
        </div>

        {/* Connect wallet */}
        <ConnectButton.Custom>
          {({ account, chain, openConnectModal, mounted }) => {
            const connected = mounted && account && chain
            return (
              <button
                onClick={connected ? toggleWallet : openConnectModal}
                className="rounded-full border border-cream-gold bg-transparent px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-cream transition-all hover:bg-gradient-to-r hover:from-gold hover:to-gold-light hover:text-[#080B10] sm:px-5 sm:text-[13px]"
              >
                {connected ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-success" />
                    {account.displayName}
                  </span>
                ) : (
                  'CONNECT WALLET'
                )}
              </button>
            )
          }}
        </ConnectButton.Custom>

        {/* Custom wallet modal */}
        <WalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
      </div>
    </header>
  )
}
