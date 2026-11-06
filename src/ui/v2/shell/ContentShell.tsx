'use client'

import { useMemo, type ReactNode } from 'react'
import { RainbowKitProvider } from '@rainbow-me/rainbowkit'
import '../v2.css'
import './shell.css'
import { v2FontClassNames } from '../font-loader'
import { PhotoBackground } from '../photos/PhotoBackground'
import { photoForDocsLegalPage } from '../photos/tab-photos'
import { createV2RainbowTheme } from './rainbowkit-theme'
import type { V2DocsLegalPage } from './docs-legal-paths'
import { Footer } from './Footer'
import { HelpFab, MusicToggle } from './Fabs'
import { Header } from './Header'
import { V2ToastProvider } from './toasts'

/**
 * [feat/ui-v2-docs-legal] The v2 shell for Docs/Terms/Privacy: the SAME header/footer/music/help chrome as
 * AppShell, minus the tab strip and tab-pane switching — these are standalone content pages, not one of the 8
 * app tabs (v1's own Header on these pages is `showNav={false}` for the same reason: no nav on a content page).
 */
export function ContentShell({ page, children }: { page: V2DocsLegalPage; children: ReactNode }) {
  const rkTheme = useMemo(() => createV2RainbowTheme(), [])
  const photo = photoForDocsLegalPage(page)

  return (
    <RainbowKitProvider theme={rkTheme} locale="en">
      <V2ToastProvider>
        <div data-ts-ui="v2" className={`ts-v2 relative min-h-screen ${v2FontClassNames}`}>
          <PhotoBackground baked={photo.id} appScrim />
          <div className="relative z-10 flex min-h-screen flex-col">
            <Header />
            <div data-ts-column="" className="flex flex-1 flex-col">
              <main className="flex-1 px-4 py-8 sm:px-8">{children}</main>
              <Footer photos={[photo]} />
            </div>
          </div>
          <MusicToggle />
          <HelpFab />
        </div>
      </V2ToastProvider>
    </RainbowKitProvider>
  )
}
