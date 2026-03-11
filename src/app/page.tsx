'use client'

import { useState, useCallback } from 'react'
import ParticleNetwork from '@/components/ParticleNetwork'
import LandingPage from '@/components/LandingPage'
import DocsPage from '@/components/DocsPage'
import LegalPage from '@/components/LegalPage'
import Header from '@/components/Header'
import SwapBox from '@/components/SwapBox'
import SwapHistory from '@/components/SwapHistory'
import DCAPanel from '@/components/DCAPanel'
import LimitOrderPanel from '@/components/LimitOrderPanel'
import ConditionalOrderPanel from '@/components/ConditionalOrderPanel'
import AnalyticsDashboard from '@/components/AnalyticsDashboard'
import WalletHistory from '@/components/WalletHistory'
import Footer from '@/components/Footer'
import HelpButton from '@/components/HelpButton'
import NotificationBanner from '@/components/NotificationBanner'
import { playTouchMP3 } from '@/lib/sounds'

export type AppPage = 'landing' | 'swap' | 'docs' | 'privacy' | 'terms'
export type SwapMode = 'instant' | 'dca' | 'limit' | 'sltp' | 'history' | 'analytics'

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
          <div className="no-scrollbar mb-4 flex w-full max-w-[calc(100vw-1.5rem)] gap-1 overflow-x-auto rounded-xl border border-cream-08 bg-surface-secondary/60 p-1 sm:max-w-[540px]">
            {([
              ['instant', 'Swap'],
              ['dca', 'DCA'],
              ['limit', 'Limit'],
              ['sltp', 'SL / TP'],
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
          ) : swapMode === 'dca' ? (
            <div className="w-full max-w-[460px]">
              <DCAPanel />
            </div>
          ) : swapMode === 'limit' ? (
            <div className="w-full max-w-[460px]">
              <LimitOrderPanel />
            </div>
          ) : swapMode === 'sltp' ? (
            <div className="w-full max-w-[460px]">
              <ConditionalOrderPanel />
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
