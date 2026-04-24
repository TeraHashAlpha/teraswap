import type { Metadata } from 'next'

// Metadata must live in a server component; the /docs page itself is a client
// component (uses wagmi hooks via Header + ParticleNetwork + router hooks),
// so this layout exists purely to set the page <title> and <meta> tags.
export const metadata: Metadata = {
  title: 'Documentation | TeraSwap',
  description:
    'TeraSwap technical documentation — architecture, security, liquidity sources, smart routing, and more.',
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children
}
