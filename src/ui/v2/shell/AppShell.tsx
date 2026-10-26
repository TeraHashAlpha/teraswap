'use client'

import { usePathname } from 'next/navigation'
import { useMemo, type ReactNode } from 'react'
import { RainbowKitProvider } from '@rainbow-me/rainbowkit'
import { useQuoteChainId } from '@/hooks/useChainId'
import '../v2.css'
import './shell.css'
import { v2FontClassNames } from '../font-loader'
import { createV2RainbowTheme } from './rainbowkit-theme'
import { DcaNetworkGate, shouldShowDcaGate } from './DcaNetworkGate'
import { Footer } from './Footer'
import { HelpFab, MusicToggle } from './Fabs'
import { Header } from './Header'
import { NoticeBanner } from './NoticeBanner'
import { TabBar } from './TabBar'
import { TabPane } from './TabPane'
import { tabIdFromPathname, type V2TabId } from './tab-paths'
import { V2ToastProvider } from './toasts'

/**
 * [ADR-025] The v2 app shell (pack 01/03/04/05): header, notice, tab strip, pane, footer, ♫ and ? fabs, toasts.
 * `tab` defaults to the one in the URL; `children` replaces the placeholder pane (B2+ pages).
 */
export function AppShell({ tab, children }: { tab?: V2TabId; children?: ReactNode }) {
  const pathname = usePathname()
  const chainId = useQuoteChainId()
  const active = tab ?? tabIdFromPathname(pathname)
  const rkTheme = useMemo(() => createV2RainbowTheme(), [])

  const pane =
    children ?? (active === 'dca' && shouldShowDcaGate(chainId) ? <DcaNetworkGate /> : <TabPane tab={active} />)

  return (
    <RainbowKitProvider theme={rkTheme} locale="en">
      <V2ToastProvider>
        <div data-ts-ui="v2" className={`ts-v2 flex min-h-screen flex-col ${v2FontClassNames}`}>
          <Header />
          <NoticeBanner />
          <TabBar active={active} />
          <main className="flex-1 px-4 py-8 sm:px-8">{pane}</main>
          <Footer />
          <MusicToggle />
          <HelpFab />
        </div>
      </V2ToastProvider>
    </RainbowKitProvider>
  )
}
