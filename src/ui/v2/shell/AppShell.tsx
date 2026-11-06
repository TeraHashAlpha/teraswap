'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useMemo, type ReactNode } from 'react'
import { RainbowKitProvider } from '@rainbow-me/rainbowkit'
import { useQuoteChainId } from '@/hooks/useChainId'
import ComingSoonPanel from '@/components/ComingSoonPanel'
import SwapErrorBoundary from '@/components/SwapErrorBoundary'
import '../v2.css'
import './shell.css'
import { v2FontClassNames } from '../font-loader'
import { PhotoBackground } from '../photos/PhotoBackground'
import { photoForTab } from '../photos/tab-photos'
import { createV2RainbowTheme } from './rainbowkit-theme'
import { DcaNetworkGate, shouldShowDcaGate } from './DcaNetworkGate'
import { Footer } from './Footer'
import { HelpFab, MusicToggle } from './Fabs'
import { Header } from './Header'
import { NoticeBanner } from './NoticeBanner'
import { TabBar } from './TabBar'
import { TabPane } from './TabPane'
import { SwapCard } from '../swap/SwapCard'
import { RecentSwaps } from '../swap/RecentSwaps'
import { DcaCard } from '../dca/DcaCard'
import { OrdersTab } from '../orders/OrdersTab'
import { HistoryTab } from '../history/HistoryTab'
import { PortfolioTab } from '../portfolio/PortfolioTab'
import { AnalyticsTab } from '../analytics/AnalyticsTab'
import { isDcaLive } from '@/lib/dca-launch'
import { tabIdFromPathname, type V2TabId } from './tab-paths'
import { V2ToastProvider } from './toasts'

/**
 * [ADR-025] The v2 app shell (pack 01/03/04/05): header, notice, tab strip, pane, footer, ♫ and ? fabs, toasts.
 * `tab` defaults to the one in the URL; `children` replaces the placeholder pane (B2+ pages). `onLogoClick` lets the
 * home page return to the landing, as v1's logo does (`setPage('landing')`).
 */
export function AppShell({ tab, children, onLogoClick }: { tab?: V2TabId; children?: ReactNode; onLogoClick?: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const chainId = useQuoteChainId()
  const active = tab ?? tabIdFromPathname(pathname)
  const rkTheme = useMemo(() => createV2RainbowTheme(), [])
  const toSwap = () => router.push('/swap')

  // B3: the Swap tab is the real card; B6: DCA; B7: Orders (v1 OrderDashboard) and History (v1 WalletHistory); B8: Portfolio (v1 PortfolioTab); B9: Analytics (v1 AnalyticsDashboard + the /analytics page).
  // [H-1, A75] Limit, SL/TP, and DCA on a chain that is neither gated (DcaNetworkGate) nor live (DcaCard) have no
  // real pane of their own: v1's ComingSoonPanel carries them, never TabPane's permanent empty skeleton — a direct
  // /limit or /sltp visit, and DCA on Arbitrum (in DCA_CHAINS, OrderExecutorV3 not yet operational per
  // docs/DEPLOYMENTS.md) or with NEXT_PUBLIC_DCA_ENABLED unset, all land here. `data-tab-pane` keeps the attribute
  // TabPane carried, so callers that query "the pane" by tab id still find it. Every other tab is still a
  // placeholder until its block lands.
  const pane =
    children ??
    (active === 'swap' ? (
      // [L-1, owner decision: BUILD in v2] v1's SwapHistory is a sibling below SwapBox (page.tsx), not inside it —
      // RecentSwaps mirrors that here, below the card.
      <>
        <SwapCard />
        <RecentSwaps />
      </>
    ) : active === 'dca' && shouldShowDcaGate(chainId) ? (
      <DcaNetworkGate />
    ) : active === 'dca' && isDcaLive(chainId) ? (
      <DcaCard key={chainId} chainId={chainId} />
    ) : active === 'dca' ? (
      <div data-tab-pane="dca">
        <ComingSoonPanel mode="dca" chainId={chainId} onSwap={toSwap} />
      </div>
    ) : active === 'limit' ? (
      <div data-tab-pane="limit">
        <ComingSoonPanel mode="limit" chainId={chainId} onSwap={toSwap} />
      </div>
    ) : active === 'sltp' ? (
      <div data-tab-pane="sltp">
        <ComingSoonPanel mode="sltp" chainId={chainId} onSwap={toSwap} />
      </div>
    ) : active === 'orders' ? (
      <OrdersTab />
    ) : active === 'history' ? (
      <HistoryTab />
    ) : active === 'portfolio' ? (
      <PortfolioTab />
    ) : active === 'analytics' ? (
      <AnalyticsTab />
    ) : (
      <TabPane tab={active} />
    ))

  return (
    <RainbowKitProvider theme={rkTheme} locale="en">
      <V2ToastProvider>
        <div data-ts-ui="v2" className={`ts-v2 relative min-h-screen ${v2FontClassNames}`}>
          <PhotoBackground tab={active} appScrim />
          <div className="relative z-10 flex min-h-screen flex-col">
            <Header onLogoClick={onLogoClick} />
            <NoticeBanner />
            <TabBar active={active} />
            {/* Round 7 D2: no solid column on mobile either — the photo (with its uniform scrim) sits behind every screen */}
            <div data-ts-column="" className="flex flex-1 flex-col">
              {/* [L-2, A75] v1 copy: SwapBox is wrapped in SwapErrorBoundary (page.tsx:131) — v2 wraps every tab's
                  pane the same way, since v2 consolidates them behind one shell. */}
              <main className="flex-1 px-4 py-8 sm:px-8">
                <SwapErrorBoundary>{pane}</SwapErrorBoundary>
              </main>
              <Footer photos={[photoForTab(active)]} />
            </div>
          </div>
          <MusicToggle />
          <HelpFab />
        </div>
      </V2ToastProvider>
    </RainbowKitProvider>
  )
}
