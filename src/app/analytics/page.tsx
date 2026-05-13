'use client'

import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import ParticleNetwork from '@/components/ParticleNetwork'
import Header from '@/components/Header'
import Footer from '@/components/Footer'

// [P99] PersonalDashboard is fully client-side (Wagmi hooks, fetch). Skip
// SSR to keep the bundle out of the server build — same posture as the
// in-app AnalyticsDashboard.
const PersonalDashboard = dynamic(
  () => import('@/components/PersonalDashboard'),
  { ssr: false },
)

export default function AnalyticsPage() {
  const router = useRouter()
  const goHome = () => router.push('/')

  return (
    <div className="flex min-h-screen flex-col">
      <ParticleNetwork />
      <Header onLogoClick={goHome} showNav={false} />
      <main className="relative z-10 mx-auto flex w-full max-w-[960px] flex-1 flex-col px-4 pb-12 pt-24 sm:px-6">
        <PersonalDashboard />
        <Footer />
      </main>
    </div>
  )
}
