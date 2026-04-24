'use client'

import { useRouter } from 'next/navigation'
import ParticleNetwork from '@/components/ParticleNetwork'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import DocsPage from '@/components/DocsPage'

export default function Docs() {
  const router = useRouter()
  // Back-navigation fallback: header logo + footer Privacy/Terms route the
  // user back to the React-state-based home page, where they can pick their
  // next destination. The Docs page itself lives at a real route (/docs),
  // so it supports deep-linking (e.g. /docs#security).
  const goHome = () => router.push('/')

  return (
    <div className="flex min-h-screen flex-col">
      <ParticleNetwork />
      <Header onLogoClick={goHome} showNav={false} />
      <main className="relative z-10 flex flex-1 flex-col">
        <DocsPage />
        <Footer onPrivacy={goHome} onTerms={goHome} />
      </main>
    </div>
  )
}
