'use client'

import { useState, useCallback } from 'react'
import ParticleNetwork from '@/components/ParticleNetwork'
import LandingPage from '@/components/LandingPage'
import DocsPage from '@/components/DocsPage'
import LegalPage from '@/components/LegalPage'
import Header from '@/components/Header'
import SwapBox from '@/components/SwapBox'
import SwapHistory from '@/components/SwapHistory'
// DCA, Limit & SL/TP — coming soon (re-enable after L2 launch)
// import DCAPanel from '@/components/DCAPanel'
// import LimitOrderPanel from '@/components/LimitOrderPanel'
// import ConditionalOrderPanel from '@/components/ConditionalOrderPanel'
import AnalyticsDashboard from '@/components/AnalyticsDashboard'
import OrderDashboard from '@/components/OrderDashboard'
import WalletHistory from '@/components/WalletHistory'
import Footer from '@/components/Footer'
import HelpButton from '@/components/HelpButton'
import NotificationBanner from '@/components/NotificationBanner'
import { playTouchMP3 } from '@/lib/sounds'

export type AppPage = 'landing' | 'swap' | 'docs' | 'privacy' | 'terms'
export type SwapMode = 'instant' | 'dca' | 'limit' | 'sltp' | 'orders' | 'history' | 'analytics'

const COMING_SOON_MODES = new Set<SwapMode>(['dca', 'limit', 'sltp'])

const COMING_SOON_META: Record<string, { icon: string; title: string; desc: string }> = {
  dca:  { icon: '⟳', title: 'Smart DCA Engine', desc: 'Automated dollar-cost averaging with price-aware buying windows. Coming to L2 soon.' },
  limit: { icon: '⇅', title: 'Limit Orders', desc: 'Set your target price and walk away. CoW Protocol solvers compete to fill your order. Coming to L2 soon.' },
  sltp: { icon: '⛨', title: 'Stop Loss / Take Profit', desc: 'Automated position protection powered by Chainlink oracles. Coming to L2 soon.' },
}

function ComingSoonPanel({ mode, onSwap }: { mode: SwapMode; onSwap: () => void }) {
  const meta = COMING_SOON_META[mode]
  if (!meta) return null
  return (
    <div className="flex flex-col items-center gap-5 rounded-2xl border border-cream-08 bg-surface-secondary/60 px-6 py-12 text-center backdrop-blur-md">
      <span className="text-5xl">{meta.icon}</span>
      <h3 className="text-xl font-bold text-cream">{meta.title}</h3>
      <p className="max-w-xs text-sm text-cream-50">{meta.desc}</p>
      <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-4 py-1.5 text-xs font-semibold text-amber-300">
        Coming Soon on L2
      </span>
      <button
        onClick={onSwap}
        className="mt-2 rounded-xl bg-cream-gold px-6 py-2.5 text-sm font-bold text-[#080B10] transition-transform hover:scale-105"
      >
        Swap Now →
      </button>
    </div>
  )
}

export default function Home() {
  const [page, setPage] = useState<AppPage>('landing')
  const [swapMode, setSwapMode] = useState<SwapMode>('instant')

  const handleLaunchApp = useCallback(() => {
    setPage('swap')
  }, [])

  const footer = (
    <Footer
      onDocs={() => setPage('docs')}
      onPrivacy={() => setPage('privacy')}
      onTerms={() => setPage('terms')}
    />
  )

  return (
    <div className="flex min-h-screen flex-col">
      {/* Particle network — always visible behind content */}
      <ParticleNetwork />

      <Header
        onLogoClick={() => setPage('landing')}
        showNav={page === 'landing'}
        onDocsClick={() => setPage('docs')}
      />

      {page === 'landing' ? (
        <main className="relative z-10 flex flex-1 flex-col">
          <LandingPage onLaunchApp={handleLaunchApp} onDocs={() => setPage('docs')} />
          {footer}
        </main>
      ) : page === 'docs' ? (
        <main className="relative z-10 flex flex-1 flex-col">
          <DocsPage />
          {footer}
        </main>
      ) : page === 'privacy' ? (
        <main className="relative z-10 flex flex-1 flex-col">
          <LegalPage type="privacy" />
          {footer}
        </main>
      ) : page === 'terms' ? (
        <main className="relative z-10 flex flex-1 flex-col">
          <LegalPage type="terms" />
          {footer}
        </main>
      ) : (
        <main className="relative z-10 flex flex-1 animate-fade-slide-in flex-col items-center justify-start px-3 pb-8 pt-20 sm:px-4 sm:pt-24">
          {/* Notification permission banner — shows once */}
          <div className="mb-3 w-full max-w-[540px]">
            <NotificationBanner />
          </div>

          {/* Swap / DCA mode toggle */}
          <div className="no-scrollbar sticky top-8 z-40 mb-4 flex w-full max-w-[calc(100vw-1.5rem)] gap-1 overflow-x-auto rounded-xl border border-cream-08 bg-surface-secondary/95 p-1 backdrop-blur-md sm:max-w-[540px]">
            {([
              ['instant', 'Swap'],
              ['dca', 'DCA'],
              ['limit', 'Limit'],
              ['sltp', 'SL / TP'],
              ['orders', 'Orders'],
              ['history', 'History'],
              ['analytics', 'Analytics'],
            ] as [SwapMode, string][]).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => { playTouchMP3(); setSwapMode(mode) }}

                className={`flex-1 whitespace-nowrap rounded-lg px-2 py-2 text-[11px] font-semibold transition-all sm:px-0 sm:text-[13px] ${
                  swapMode === mode
                    ? 'bg-cream-gold text-[#080B10]'
                    : 'text-cream-50 hover:text-cream'
                }`}
              >
                {label}
                {COMING_SOON_MODES.has(mode) && (
                  <span className="ml-1 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[8px] font-bold text-amber-300 sm:text-[9px]">
                    Soon
                  </span>
                )}
              </button>
            ))}
          </div>

          {swapMode === 'instant' ? (
            <>
              <SwapBox />
              <div className="w-full max-w-[460px]">
                <SwapHistory />
              </div>
            </>
          ) : COMING_SOON_MODES.has(swapMode) ? (
            <div className="w-full max-w-[460px]">
              <ComingSoonPanel mode={swapMode} onSwap={() => setSwapMode('instant')} />
            </div>
          ) : swapMode === 'orders' ? (
            <div className="w-full max-w-[460px]">
              <OrderDashboard />
            </div>
          ) : swapMode === 'history' ? (
            <div className="w-full max-w-[460px]">
              <WalletHistory />
            </div>
          ) : (
            <div className="w-full max-w-[820px]">
              <AnalyticsDashboard />
            </div>
          )}
          {footer}
        </main>
      )}

      {/* Floating help button — visible everywhere except landing */}
      {page !== 'landing' && <HelpButton />}
    </div>
  )
}
