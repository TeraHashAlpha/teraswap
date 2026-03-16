'use client'

import dynamic from 'next/dynamic'

// [SSR-FIX] Dynamically import Providers with ssr: false.
// WalletConnect (used by wagmi/RainbowKit) accesses localStorage during init,
// which crashes Next.js static page prerendering. Lazy-loading the provider tree
// ensures all wallet/web3 code only runs on the client.
const Providers = dynamic(() => import('./providers'), { ssr: false })

export default function ClientProviders({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>
}
