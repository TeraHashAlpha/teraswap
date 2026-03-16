const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'tokens.1inch.io' },
      { protocol: 'https', hostname: 'assets.coingecko.com' },
    ],
  },

  // ── Security Headers ──────────────────────────────────
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Scripts: self + inline (Next.js requires it); unsafe-eval only in dev
              `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
              // Styles: self + inline (Tailwind/Next.js) + Google Fonts CSS
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              // Images: self + token icon CDNs + data URIs
              "img-src 'self' data: https://tokens.1inch.io https://assets.coingecko.com https://raw.githubusercontent.com",
              // Fonts: self + Google Fonts + Fontshare CDN
              "font-src 'self' data: https://fonts.gstatic.com https://cdn.fontshare.com",
              // Connect: aggregator APIs + RPC + WalletConnect + CoW + Etherscan
              "connect-src 'self' https://api.1inch.dev https://api.0x.org https://api.paraswap.io https://api.odos.xyz https://aggregator-api.kyberswap.com https://api.cow.fi https://open-api.openocean.finance https://api.sushi.com https://api-v3.balancer.fi https://eth.llamarpc.com https://*.infura.io https://*.alchemy.com wss://*.walletconnect.com wss://*.walletconnect.org https://*.walletconnect.com https://explorer-api.walletconnect.com https://rpc.walletconnect.com https://relay.walletconnect.com https://api.etherscan.io https://api.web3modal.org https://api.web3modal.com https://*.supabase.co wss://*.supabase.co https://rpc.ankr.com https://ethereum-rpc.publicnode.com https://eth.merkle.io https://*.ingest.sentry.io",
              // Media: self (local sound files in /public/sounds/)
              "media-src 'self' blob:",
              // Frames: none (clickjacking protection)
              "frame-src 'none'",
              "frame-ancestors 'none'",
              // Objects: none
              "object-src 'none'",
              // Base URI
              "base-uri 'self'",
              // Form actions
              "form-action 'self'",
            ].join('; '),
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          // Supply chain protection: require SRI for external scripts
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'same-origin',
          },
        ],
      },
    ]
  },
}

module.exports = withSentryConfig(nextConfig, {
  // Suppress noisy build logs
  silent: true,
  // Hide source maps from browser devtools
  hideSourceMaps: true,
})
