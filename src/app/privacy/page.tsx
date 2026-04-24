'use client'

import { useRouter } from 'next/navigation'
import ParticleNetwork from '@/components/ParticleNetwork'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import LegalPage from '@/components/LegalPage'

export default function Privacy() {
  const router = useRouter()
  // Header logo routes back to the React-state-based home page.
  const goHome = () => router.push('/')

  return (
    <div className="flex min-h-screen flex-col">
      <ParticleNetwork />
      <Header onLogoClick={goHome} showNav={false} />
      <main className="relative z-10 flex flex-1 flex-col">
        <LegalPage type="privacy" />
        <Footer />
      </main>
    </div>
  )
}
