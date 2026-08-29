'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount } from 'wagmi'
import dynamic from 'next/dynamic'
import ParticleNetwork from '@/components/ParticleNetwork'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import PublicProtocolStats, {
  type PublicStatsPayload,
} from '@/components/PublicProtocolStats'

const PersonalDashboard = dynamic(
  () => import('@/components/PersonalDashboard'),
  { ssr: false },
)

export default function AnalyticsPage() {
  const router = useRouter()
  const goHome = () => router.push('/')
  const { isConnected } = useAccount()
  const [payload, setPayload] = useState<PublicStatsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/stats')
      .then((r) => {
        if (!r.ok) throw new Error('stats_http')
        return r.json() as Promise<PublicStatsPayload>
      })
      .then((data) => {
        if (!alive) return
        setPayload(data)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setFailed(true)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="flex min-h-screen flex-col">
      <ParticleNetwork />
      <Header onLogoClick={goHome} showNav={false} />
      <main className="relative z-10 mx-auto flex w-full max-w-[960px] flex-1 flex-col gap-8 px-4 pb-12 pt-24 sm:px-6">
        <PublicProtocolStats payload={payload} loading={loading} failed={failed} />
        {isConnected && <PersonalDashboard />}
        <Footer />
      </main>
    </div>
  )
}
