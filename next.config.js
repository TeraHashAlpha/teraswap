const { withSentryConfig } = require('@sentry/nextjs')
const { buildContentSecurityPolicy } = require('./csp-policy')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // [fix/user-ip-privacy] No `images.remotePatterns`: next/image only ever serves our own bundled
  // photos (src/ui/v2/photos), and every token logo is an <img> on /api/token-logo or /api/proxy/logo.
  // A remote pattern would let the image optimizer fetch a third-party host on a visitor's request.

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
            // [fix/user-ip-privacy] Built from csp-policy.js, where every source carries its reason:
            // connect-src is 'self' + the exact wallet hosts needed after a wallet is chosen, and
            // img-src is 'self' data: blob:. Do not add a host here — add it there, with a reason.
            value: buildContentSecurityPolicy({ isDev: process.env.NODE_ENV === 'development' }),
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
