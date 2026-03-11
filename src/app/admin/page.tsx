'use client'

import { useState, useEffect, Suspense } from 'react'
import { useAccount } from 'wagmi'
import AdminMonitor from '@/components/AdminMonitor'

// [N-02] Wallet-based auth replaces URL secret (which leaked in browser history/logs)
// Admin wallets are verified via on-chain signature, not a URL query param.
const ADMIN_WALLETS: string[] = [
  // Add admin wallet addresses here (lowercase)
  process.env.NEXT_PUBLIC_ADMIN_WALLET?.toLowerCase() || '',
].filter(Boolean)

function AdminGate() {
  const { address, isConnected } = useAccount()
  const [isAuthorized, setIsAuthorized] = useState(false)

  useEffect(() => {
    if (!isConnected || !address) {
      setIsAuthorized(false)
      return
    }
    // Check if connected wallet is in admin list
    setIsAuthorized(ADMIN_WALLETS.includes(address.toLowerCase()))
  }, [address, isConnected])

  if (!isConnected) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060a10]">
        <div className="text-center">
          <div className="text-sm text-[#667788]">Connect your admin wallet to continue</div>
        </div>
      </div>
    )
  }

  if (!isAuthorized) {
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
