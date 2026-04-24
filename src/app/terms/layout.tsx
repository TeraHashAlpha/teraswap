import type { Metadata } from 'next'

// Metadata must live in a server component; the /terms page itself is a
// client component (wagmi hooks via Header), so this layout exists purely
// to set the page <title> and <meta> tags.
export const metadata: Metadata = {
  title: 'Terms of Service | TeraSwap',
  description: 'TeraSwap Terms of Service — user agreement, disclaimers, and legal terms.',
}

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return children
}
