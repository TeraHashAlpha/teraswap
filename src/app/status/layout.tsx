import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'TeraSwap Monitor — Source Health Status',
  description: 'Real-time health status of all TeraSwap DEX aggregator sources.',
  robots: { index: true, follow: true },
}

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return children
}
