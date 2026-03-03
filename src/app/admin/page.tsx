'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import AdminMonitor from '@/components/AdminMonitor'

// ── Secret key — change this before deploying! ──
const ADMIN_KEY = 'teraswap-alpha-2026'

function AdminGate() {
  const params = useSearchParams()
  const key = params.get('key')

  if (key !== ADMIN_KEY) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060a10]">
        <div className="text-center">
          <div className="text-sm text-[#445566]">404</div>
          <div className="mt-1 text-[10px] text-[#334455]">Page not found</div>
        </div>
      </div>
    )
  }

  return <AdminMonitor />
}

export default function AdminPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-[#060a10]">
        <div className="text-sm text-[#445566]">Loading...</div>
      </div>
    }>
      <AdminGate />
    </Suspense>
  )
}
