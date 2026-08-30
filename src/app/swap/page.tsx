'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useChainId } from 'wagmi'
import dynamic from 'next/dynamic'
import ParticleNetwork from '@/components/ParticleNetwork'
import Header from '@/components/Header'
import SwapBox from '@/components/SwapBox'
import SwapHistory from '@/components/SwapHistory'
import ModeTabs from '@/components/ModeTabs'
import Footer from '@/components/Footer'
import SwapErrorBoundary from '@/components/SwapErrorBoundary'
import HelpButton from '@/components/HelpButton'
import NotificationBanner from '@/components/NotificationBanner'
import { playTouchMP3 } from '@/lib/sounds'
import { isDcaLive } from '@/lib/dca-launch'
import { isLimitLive } from '@/lib/order-engine'

const AnalyticsDashboard = dynamic(() => import('@/components/AnalyticsDashboard'), { ssr: false })
const OrderDashboard = dynamic(() => import('@/components/OrderDashboard'), { ssr: false })
const WalletHistory = dynamic(() => import('@/components/WalletHistory'), { ssr: false })
const PortfolioTab = dynamic(() => import('@/components/PortfolioTab'), { ssr: false })
const DCAPanel = dynamic(() => import('@/components/DCAPanel'), { ssr: false })
const LimitOrderPanel = dynamic(() => import('@/components/LimitOrderPanel'), { ssr: false })
const ConditionalOrderPanel = dynamic(() => import('@/components/ConditionalOrderPanel'), { ssr: false })

export type SwapMode = 'instant' | 'portfolio' | 'dca' | 'limit' | 'sltp' | 'orders' | 'history' | 'analytics'

const COMING_SOON_MODES = new Set<SwapMode>(['dca', 'limit', 'sltp'])

const COMING_SOON_META: Record<string, { icon: string; title: string; desc: string }> = {
  dca:  { icon: '⟳', title: 'Smart DCA Engine', desc: 'Automated dollar-cost averaging with price-aware buying windows. Coming to L2 soon.' },
  limit: { icon: '◇', title: 'Limit Orders', desc: 'Set your price and let the order execute autonomously on-chain. Coming to L2 soon.' },
  sltp: { icon: '◆', title: 'Take Profit', desc: 'Lock in gains automatically when your target is hit. Coming to L2 soon.' },
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

export default function SwapPage() {
  const router = useRouter()
  const [swapMode, setSwapMode] = useState<SwapMode>('instant')
  const chainId = useChainId()
  const dcaLive = isDcaLive(chainId)
  const limitLive = isLimitLive(chainId)

  return (
    <div className="flex min-h-screen flex-col">
      <ParticleNetwork />

      <Header
        onLogoClick={() => router.push('/')}
        showNav={false}
      />

      <main className="swap-main relative z-10 flex flex-1 animate-fade-slide-in flex-col items-center justify-start px-3 pb-8 pt-20 sm:px-4 sm:pt-24">
        <div className="mb-3 w-full max-w-[540px]">
          <NotificationBanner />
        </div>

        <ModeTabs
          tabs={([
            ['instant', 'Swap'],
            ['portfolio', 'Portfolio'],
            ['dca', 'DCA'],
            ['limit', 'Limit'],
            ['sltp', 'SL/TP'],
            ['orders', 'Orders'],
            ['history', 'History'],
            ['analytics', 'Analytics'],
          ] as [SwapMode, string][]).map(([mode, label]) => ({
            mode,
            label,
            comingSoon:
              COMING_SOON_MODES.has(mode) &&
              !(mode === 'dca' && dcaLive) &&
              !((mode === 'limit' || mode === 'sltp') && limitLive),
          }))}
          active={swapMode}
          onSelect={(mode) => { playTouchMP3(); setSwapMode(mode as SwapMode) }}
        />

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
            <PortfolioTab onSwapToken={() => setSwapMode('instant')} />
          </div>
        ) : swapMode === 'dca' && dcaLive ? (
          <div className="w-full max-w-[460px]">
            <DCAPanel />
          </div>
        ) : swapMode === 'limit' && limitLive ? (
          <div className="w-full max-w-[460px]">
            <LimitOrderPanel />
          </div>
        ) : swapMode === 'sltp' && limitLive ? (
          <div className="w-full max-w-[460px]">
            <ConditionalOrderPanel />
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
        <Footer />
      </main>

      <HelpButton />
    </div>
  )
}
