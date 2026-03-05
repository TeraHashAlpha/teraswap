'use client'

import { useState, useCallback } from 'react'
import ParticleNetwork from '@/components/ParticleNetwork'
import LandingPage from '@/components/LandingPage'
import DocsPage from '@/components/DocsPage'
import LegalPage from '@/components/LegalPage'
import Header from '@/components/Header'
import SwapBox from '@/components/SwapBox'
import SwapHistory from '@/components/SwapHistory'
// DCA, Limit, and SL/TP panels — temporarily disabled (Coming Soon)
// import DCAPanel from '@/components/DCAPanel'
// import LimitOrderPanel from '@/components/LimitOrderPanel'
// import ConditionalOrderPanel from '@/components/ConditionalOrderPanel'
import AnalyticsDashboard from '@/components/AnalyticsDashboard'
import WalletHistory from '@/components/WalletHistory'
import Footer from '@/components/Footer'
import HelpButton from '@/components/HelpButton'

export type AppPage = 'landing' | 'swap' | 'docs' | 'privacy' | 'terms'
export type SwapMode = 'instant' | 'dca' | 'limit' | 'sltp' | 'history' | 'analytics'

// ── Coming Soon placeholder for DCA / Limit / SL·TP ──────
const COMING_SOON_META: Record<string, { title: string; icon: string; desc: string }> = {
  dca: {
    title: 'DCA — Dollar Cost Averaging',
    icon: '⟳',
    desc: 'Automated position building with price-aware execution windows. Set your schedule and let TeraSwap handle the rest — fully autonomous, no browser required.',
  },
  limit: {
    title: 'Limit Orders',
    icon: '⇅',
    desc: 'Set your target price and walk away. CoW Protocol solvers execute when the market reaches your level — zero gas, MEV-protected.',
  },
  sltp: {
    title: 'Stop Loss / Take Profit',
    icon: '⛨',
    desc: 'Protect positions or lock in gains with Chainlink oracle triggers. Fully autonomous on-chain execution — your trades run while you sleep.',
  },
}

function ComingSoonPanel({ mode, onSwapNow }: { mode: string; onSwapNow: () => void }) {
  const meta = COMING_SOON_META[mode] ?? COMING_SOON_META.dca
  return (
    <div className="w-full max-w-[460px] animate-fade-slide-in rounded-2xl border border-cream-08 bg-surface-secondary/70 p-8 text-center backdrop-blur-sm">
      {/* Icon */}
      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-cream-08 bg-surface text-2xl" style={{ color: '#C8B89A' }}>
        {meta.icon}
      </div>

      {/* Title */}
      <h2 className="mb-2 font-display text-xl font-bold text-cream">{meta.title}</h2>

      {/* Badge */}
      <span className="mb-5 inline-block rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider" style={{ background: 'rgba(200,184,154,0.12)', color: '#C8B89A' }}>
        Coming Soon
      </span>

      {/* Description */}
      <p className="mx-auto mb-6 max-w-sm text-sm leading-relaxed text-cream-65">{meta.desc}</p>

      {/* Progress note */}
      <div className="mb-6 rounded-xl border border-cream-08 bg-surface px-4 py-3">
        <p className="text-xs text-cream-50">
          We&apos;re finishing the autonomous order engine powered by{' '}
          <span className="font-semibold text-cream-75">Gelato Network</span> and{' '}
          <span className="font-semibold text-cream-75">Chainlink Oracles</span>.
          Orders will execute on-chain without your browser needing to stay open.
        </p>
      </div>

      {/* CTA */}
      <button
        onClick={onSwapNow}
        className="inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-[#080B10] transition-all hover:scale-[1.02]"
        style={{ background: 'linear-gradient(135deg, #C8B89A 0%, #E8D5B7 50%, #C8B89A 100%)' }}
      >
        Swap Now
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
          {/* Swap / DCA mode toggle */}
          <div className="no-scrollbar mb-4 flex w-full max-w-[calc(100vw-1.5rem)] gap-1 overflow-x-auto rounded-xl border border-cream-08 bg-surface-secondary/60 p-1 sm:max-w-[540px]">
            <button
              onClick={() => setSwapMode('instant')}
              className={`flex-1 whitespace-nowrap rounded-lg px-2 py-2 text-[11px] font-semibold transition-all sm:px-0 sm:text-[13px] ${
                swapMode === 'instant'
                  ? 'bg-cream-gold text-[#080B10]'
                  : 'text-cream-50 hover:text-cream'
              }`}
            >
              Swap
            </button>
            <button
              onClick={() => setSwapMode('dca')}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-all sm:px-0 sm:text-[13px] ${
                swapMode === 'dca'
                  ? 'bg-cream-gold text-[#080B10]'
                  : 'text-cream-35 hover:text-cream-50'
              }`}
            >
              DCA
              <span className={`rounded-full px-1.5 py-[1px] text-[8px] font-semibold uppercase leading-none tracking-wide sm:text-[9px] ${swapMode === 'dca' ? 'bg-[#080B10]/20 text-[#080B10]/70' : 'bg-cream-15/40 text-cream-50'}`}>soon</span>
            </button>
            <button
              onClick={() => setSwapMode('limit')}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-all sm:px-0 sm:text-[13px] ${
                swapMode === 'limit'
                  ? 'bg-cream-gold text-[#080B10]'
                  : 'text-cream-35 hover:text-cream-50'
              }`}
            >
              Limit
              <span className={`rounded-full px-1.5 py-[1px] text-[8px] font-semibold uppercase leading-none tracking-wide sm:text-[9px] ${swapMode === 'limit' ? 'bg-[#080B10]/20 text-[#080B10]/70' : 'bg-cream-15/40 text-cream-50'}`}>soon</span>
            </button>
            <button
              onClick={() => setSwapMode('sltp')}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-all sm:px-0 sm:text-[13px] ${
                swapMode === 'sltp'
                  ? 'bg-cream-gold text-[#080B10]'
                  : 'text-cream-35 hover:text-cream-50'
              }`}
            >
              SL / TP
              <span className={`rounded-full px-1.5 py-[1px] text-[8px] font-semibold uppercase leading-none tracking-wide sm:text-[9px] ${swapMode === 'sltp' ? 'bg-[#080B10]/20 text-[#080B10]/70' : 'bg-cream-15/40 text-cream-50'}`}>soon</span>
            </button>
            <button
              onClick={() => setSwapMode('history')}
              className={`flex-1 whitespace-nowrap rounded-lg px-2 py-2 text-[11px] font-semibold transition-all sm:px-0 sm:text-[13px] ${
                swapMode === 'history'
                  ? 'bg-cream-gold text-[#080B10]'
                  : 'text-cream-50 hover:text-cream'
              }`}
            >
              History
            </button>
            <button
              onClick={() => setSwapMode('analytics')}
              className={`flex-1 whitespace-nowrap rounded-lg px-2 py-2 text-[11px] font-semibold transition-all sm:px-0 sm:text-[13px] ${
                swapMode === 'analytics'
                  ? 'bg-cream-gold text-[#080B10]'
                  : 'text-cream-50 hover:text-cream'
              }`}
            >
              Analytics
            </button>
          </div>

          {swapMode === 'instant' ? (
            <>
              <SwapBox />
              <div className="w-full max-w-[460px]">
                <SwapHistory />
              </div>
            </>
          ) : swapMode === 'dca' || swapMode === 'limit' || swapMode === 'sltp' ? (
            <ComingSoonPanel mode={swapMode} onSwapNow={() => setSwapMode('instant')} />
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
