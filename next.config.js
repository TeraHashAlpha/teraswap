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

  // ── Host canonicalization [SPRINT-9M] ─────────────────
  // Canonical host is www.teraswap.app (matches layout.tsx SITE_URL + WC metadata).
  // Enforce apex → www so a single origin serves. The rule fires only when the Host
  // header is exactly the apex; www, *.vercel.app previews, and localhost don't match
  // (no redirect loop). 308 permanent. On Vercel a domain-level redirect (apex → www)
  // can also be configured in Project → Domains (edge-level, fires before this) — see
  // FEEDBACK; the two coexist safely (edge redirect makes this a no-op fallback).
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'teraswap.app' }],
        destination: 'https://www.teraswap.app/:path*',
        permanent: true,
      },
    ]
  },

  // ── Security Headers ──────────────────────────────────
  // [FE-L-01] Defense-in-depth: vercel.json mirrors all headers below EXCEPT CSP.
  // CSP is Next.js-only because it uses dynamic directives (unsafe-eval in dev).
  // If you add/change a header here, sync vercel.json to keep the edge fallback current.
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
              // worker-src 'self' required for service worker registration
              `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
              "worker-src 'self'",
              // Styles: self + inline (Tailwind/Next.js)
              "style-src 'self' 'unsafe-inline'",
              // Images: self + token icon CDNs + data URIs + blob: object URLs.
              // [wallet-logos-fix] blob: is REQUIRED for the WalletConnect/Reown "All Wallets"
              // modal: AppKit fetches each wallet logo via JS (allowed by connect-src below) and
              // renders it as a same-origin blob: object URL in an <img>. Without blob: here, every
              // wallet icon is CSP-blocked (img-src) → generic placeholder. Mirrors media-src's blob:.
              "img-src 'self' data: blob: https://tokens.1inch.io https://assets.coingecko.com https://raw.githubusercontent.com",
              // Fonts: self (Inter/JetBrains Mono via next/font) + Fontshare CDN (Clash Display)
              "font-src 'self' data: https://cdn.fontshare.com",
              // Connect: aggregator APIs + RPC + WalletConnect + CoW + Etherscan
              "connect-src 'self' https://api.1inch.dev https://api.0x.org https://api.paraswap.io https://aggregator-api.kyberswap.com https://api.cow.fi https://open-api.openocean.finance https://api.sushi.com https://api-v3.balancer.fi https://eth.llamarpc.com https://*.infura.io https://*.alchemy.com wss://*.walletconnect.com wss://*.walletconnect.org https://*.walletconnect.com https://*.walletconnect.org https://explorer-api.walletconnect.com https://rpc.walletconnect.com https://relay.walletconnect.com https://metamask-sdk.api.cx.metamask.io wss://metamask-sdk.api.cx.metamask.io https://api.etherscan.io https://api.web3modal.org https://api.web3modal.com https://*.supabase.co wss://*.supabase.co https://rpc.ankr.com https://ethereum-rpc.publicnode.com https://eth.merkle.io https://*.ingest.sentry.io https://cdn.fontshare.com",
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
            value: 'same-origin-allow-popups',
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'same-origin',
          },
        ],
      },
    ]
  },

  // [P92] Webpack chunk splitting for viem/wagmi/rainbowkit.
  // NOTE: Next.js 16 defaults to Turbopack for `next build`, which silently
  // ignores this webpack() callback. Kept here for two reasons: (a) it
  // documents the intended chunk strategy, (b) it activates automatically
  // if/when the project falls back to webpack (e.g. `next build --no-turbopack`
  // or future migrations). See FEEDBACK.md for measured savings.
  webpack(config) {
    config.optimization.splitChunks = {
      ...config.optimization.splitChunks,
      cacheGroups: {
        ...config.optimization.splitChunks?.cacheGroups,
        viem: {
          test: /[\\/]node_modules[\\/]viem[\\/]/,
          name: 'viem',
          chunks: 'all',
          priority: 30,
        },
        wagmi: {
          test: /[\\/]node_modules[\\/](@wagmi|wagmi|@rainbow-me)[\\/]/,
          name: 'wagmi',
          chunks: 'all',
          priority: 25,
        },
      },
    }
    return config
  },
}

module.exports = withSentryConfig(nextConfig, {
  // Suppress noisy build logs
  silent: true,
  // Hide source maps from browser devtools
  hideSourceMaps: true,
})
