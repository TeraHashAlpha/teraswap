import type { Metadata } from 'next'
import ClientProviders from './client-providers'
import ServiceWorkerRegistration from '@/components/ServiceWorkerRegistration'
import './globals.css'

const SITE_URL = 'https://teraswap.app'
const SITE_TITLE = 'TeraSwap — The Gold Standard of DeFi Trading'
const SITE_DESCRIPTION =
  'Maximum liquidity. Absolute protection. TeraSwap is an Ethereum meta-aggregator that queries 11 liquidity sources to find the best swap rate — with multi-oracle price protection (Chainlink + DefiLlama), MEV-free execution via CoW Protocol, and a privacy proxy that hides your IP from all external services.'

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  keywords: [
    'DeFi', 'DEX aggregator', 'meta-aggregator', 'Ethereum', 'swap',
    'TeraSwap', '1inch', '0x', 'CoW Protocol', 'Uniswap', 'ParaSwap',
    'Odos', 'KyberSwap', 'Chainlink', 'MEV protection', 'best rate',
    'privacy', 'IP protection', 'DefiLlama', 'non-custodial',
  ],
  authors: [{ name: 'TeraSwap' }],
  creator: 'TeraSwap',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: SITE_URL,
    siteName: 'TeraSwap',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'TeraSwap — Ethereum Meta-Aggregator',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ['/og-image.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'TeraSwap',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#080B10" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {/* Preload Clash Display for instant headline rendering */}
        <link
          rel="preload"
          href="https://cdn.fontshare.com/wf/BPYOJXAOZVHRZK2YLFWMFWU5HEA2GNLK/TPHK4DOJQVNZWU3XPQAESXNV6DGY7PEZ/LUVMMEVY6IOL4R6YQIMAHLHVH33LNQHD.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <ServiceWorkerRegistration />
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  )
}
