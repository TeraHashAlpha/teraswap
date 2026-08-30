import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import ClientProviders from './client-providers'
import ServiceWorkerRegistration from '@/components/ServiceWorkerRegistration'
import { SITE_META_DESCRIPTION } from '@/config/product-claims'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-inter',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-mono',
})

const SITE_URL = 'https://www.teraswap.app'
const SITE_TITLE = 'TeraSwap — The Gold Standard of DeFi Trading'
const SITE_DESCRIPTION = SITE_META_DESCRIPTION

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  keywords: [
    'DeFi', 'DEX aggregator', 'meta-aggregator', 'Ethereum', 'swap',
    'TeraSwap', '1inch', '0x', 'CoW Protocol', 'Uniswap', 'ParaSwap',
    'KyberSwap', 'Chainlink', 'MEV protection', 'best rate',
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
    <html lang="en" className={`dark ${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#080B10" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {/* Preconnect — critical external origins */}
        <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cdn.fontshare.com" />
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
        <Analytics />
      </body>
    </html>
  )
}
