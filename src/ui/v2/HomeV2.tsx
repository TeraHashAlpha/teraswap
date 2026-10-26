'use client'

import { useCallback, useState } from 'react'
import { LandingV2 } from './landing'
import { AppShell } from './shell'

// [ADR-025] `/` under the switch. The same landing-vs-app split v1 uses (src/app/page.tsx):
//   const [page, setPage] = useState<AppPage>('landing')        // line 49 — every fresh visit starts on the landing
//   const handleLaunchApp = useCallback(() => { setPage('swap') }, [])   // lines 68-70 — every CTA lands here
//   {page === 'landing' ? <LandingPage onLaunchApp={handleLaunchApp} /> : <swap app> }
// In-memory state, no URL change, no cookie: a visitor "without app state" is any visitor who has not pressed a
// Launch CTA in this page view. The app side is the Swap tab (owner review, 26 Oct); the logo returns to the landing,
// as v1's `onLogoClick={() => setPage('landing')}` does.
type AppPage = 'landing' | 'swap'

export default function HomeV2() {
  const [page, setPage] = useState<AppPage>('landing')
  const launch = useCallback(() => setPage('swap'), [])
  const home = useCallback(() => setPage('landing'), [])
  return page === 'landing' ? <LandingV2 onLaunchApp={launch} /> : <AppShell tab="swap" onLogoClick={home} />
}
