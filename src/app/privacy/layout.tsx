import type { Metadata } from 'next'

// Metadata must live in a server component; the /privacy page itself is a
// client component (wagmi hooks via Header), so this layout exists purely
// to set the page <title> and <meta> tags.
export const metadata: Metadata = {
  title: 'Privacy Policy | TeraSwap',
  description: 'TeraSwap Privacy Policy — how we handle user data, IP proxying, and analytics.',
}

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return children
}
