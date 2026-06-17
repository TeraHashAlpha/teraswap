'use client'

import { useState, useCallback } from 'react'
import { useChainId } from 'wagmi'
import ParticleNetwork from '@/components/ParticleNetwork'
import LandingPage from '@/components/LandingPage'
import ScrollSpy from '@/components/ScrollSpy'
import Header from '@/components/Header'
import SwapBox from '@/components/SwapBox'
import SwapHistory from '@/components/SwapHistory'
import dynamic from 'next/dynamic'
// Q5: Dynamic imports for heavy components (charts, tables) — loaded on demand
const AnalyticsDashboard = dynamic(() => import('@/components/AnalyticsDashboard'), { ssr: false })
const OrderDashboard = dynamic(() => import('@/components/OrderDashboard'), { ssr: false })
const WalletHistory = dynamic(() => import('@/components/WalletHistory'), { ssr: false })
// [P167] Portfolio tab is wallet-dependent — never server-render.
const PortfolioTab = dynamic(() => import('@/components/PortfolioTab'), { ssr: false })
// [SPRINT-DCA-UNGATE] DCA panel is wallet-dependent (encrypted localStorage + EIP-712 signing) —
// never server-render. Only mounted once the launch flag + Base gate (isDcaLive) is satisfied.
const DCAPanel = dynamic(() => import('@/components/DCAPanel'), { ssr: false })
import Footer from '@/components/Footer'
import SwapErrorBoundary from '@/components/SwapErrorBoundary'
import HelpButton from '@/components/HelpButton'
import NotificationBanner from '@/components/NotificationBanner'
import { playTouchMP3 } from '@/lib/sounds'
import { isDcaLive } from '@/lib/dca-launch'

// /docs, /privacy, and /terms each have their own Next.js route, so they
// don't need to be part of the in-memory AppPage state machine.
export type AppPage = 'landing' | 'swap'
// [CHORE-ORDER-EXEC-PREP B] Limit + SL/TP tabs removed from the nav (kept DCA as the "Soon" teaser).
// LimitOrderPanel / ConditionalOrderPanel components are NOT deleted (rule #4) — only unwired from
// the nav; re-add 'limit'/'sltp' here (+ array + COMING_SOON_META) to re-wire later.
export type SwapMode = 'instant' | 'portfolio' | 'dca' | 'orders' | 'history' | 'analytics'

const COMING_SOON_MODES = new Set<SwapMode>(['dca'])

const COMING_SOON_META: Record<string, { icon: string; title: string; desc: string }> = {
  dca:  { icon: '⟳', title: 'Smart DCA Engine', desc: 'Automated dollar-cost averaging with price-aware buying windows. Coming to L2 soon.' },
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

  // [SPRINT-DCA-UNGATE] DCA is offered only when the launch flag is on AND the wallet is on Base
  // with a wired OrderExecutor (see isDcaLive). Default (flag off / not Base) ⇒ false ⇒ the DCA tab
  // stays the "Soon" teaser, byte-identical to today.
  const chainId = useChainId()
  const dcaLive = isDcaLive(chainId)

  const handleLaunchApp = useCallback(() => {
    setPage('swap')
  }, [])

  const footer = <Footer />

  return (
    <div className="flex min-h-screen flex-col">
      {/* Particle network — sits at canvas z-0 (see ParticleNetwork.tsx);
          page content is `relative z-10` below. Sections render at
          `bg-surface/80` so particles bleed through subtly across the
          whole page rather than being trapped behind opaque blocks
          (Sprint 27B / Prompt 70). */}
      <ParticleNetwork />

      <Header
        onLogoClick={() => setPage('landing')}
        showNav={page === 'landing'}
      />

      {page === 'landing' ? (
        <main className="relative z-10 flex flex-1 flex-col">
          {/* [P88] Desktop-only dot navigation. Hidden below lg breakpoint;
              IntersectionObserver tracks the topmost intersecting section. */}
          <ScrollSpy />
          <LandingPage onLaunchApp={handleLaunchApp} />
          {footer}
        </main>
      ) : (
        <main className="swap-main relative z-10 flex flex-1 animate-fade-slide-in flex-col items-center justify-start px-3 pb-8 pt-20 sm:px-4 sm:pt-24">
          {/* Notification permission banner — shows once */}
          <div className="mb-3 w-full max-w-[540px]">
            <NotificationBanner />
          </div>

          {/* Swap / DCA mode toggle — scrolls horizontally on narrow viewports
              with a right-side fade hint that more tabs exist beyond the edge. */}
          <div className="no-scrollbar tab-bar-fade sticky top-0 z-40 mb-4 flex w-full max-w-[calc(100vw-1.5rem)] snap-x snap-mandatory gap-1 overflow-x-auto rounded-xl border border-cream-08 bg-surface-secondary/95 p-1 backdrop-blur-md sm:max-w-[540px]">
            {([
              ['instant', 'Swap'],
              ['portfolio', 'Portfolio'],
              ['dca', 'DCA'],
              ['orders', 'Orders'],
              ['history', 'History'],
              ['analytics', 'Analytics'],
            ] as [SwapMode, string][]).map(([mode, label]) => {
              // DCA leaves the "Soon" teaser only when it's live; all other coming-soon modes stay gated.
              const comingSoon = COMING_SOON_MODES.has(mode) && !(mode === 'dca' && dcaLive)
              return (
                <button
                  key={mode}
                  onClick={() => { if (comingSoon) return; playTouchMP3(); setSwapMode(mode) }}
                  disabled={comingSoon}
                  aria-disabled={comingSoon}
                  title={comingSoon ? 'Coming soon' : undefined}
                  className={`flex-1 snap-start whitespace-nowrap rounded-lg px-2 py-3 text-[11px] font-semibold transition-all sm:px-0 sm:py-2 sm:text-[13px] ${
                    comingSoon
                      ? 'cursor-not-allowed text-cream-35 opacity-50'
                      : swapMode === mode
                        ? 'bg-cream-gold text-[#080B10]'
                        : 'text-cream-50 hover:text-cream'
                  }`}
                >
                  {label}
                  {comingSoon && (
                    <span className="ml-1 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[7px] font-bold text-amber-300 sm:text-[9px]">
                      Soon
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {swapMode === 'instant' ? (
            <>
              <SwapErrorBoundary>
                <SwapBox />
              </SwapErrorBoundary>
              <div className="w-full max-w-[460px]">
                <SwapHistory />
              </div>
            </>
          ) : swapMode === 'portfolio' ? (
            <div className="w-full max-w-[540px]">
              {/* [P167] Pre-selecting the token inside SwapBox would require a
                  cross-component store refactor; per sprint spec we just
                  switch tabs and let the user pick. */}
              <PortfolioTab onSwapToken={() => setSwapMode('instant')} />
            </div>
          ) : swapMode === 'dca' && dcaLive ? (
            <div className="w-full max-w-[460px]">
              {/* [SPRINT-DCA-UNGATE] Functional DCA panel — only reachable when the launch flag is on
                  and the wallet is on Base (the tab is otherwise disabled, so this is defensive too). */}
              <DCAPanel />
            </div>
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
