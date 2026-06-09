import type { MetadataRoute } from 'next'

/**
 * [CHORE-POLISH P4] Next.js App Router sitemap → generated at /sitemap.xml, which
 * public/robots.txt already points at (previously 404'd). Public, user-facing
 * routes only: excludes /api/* and the wallet-gated /admin + /analytics dashboards
 * (no SEO value, auth-required).
 *
 * BASE_URL mirrors SITE_URL in app/layout.tsx — the single canonical host
 * (apex→www is redirect-enforced in next.config).
 */
const BASE_URL = 'https://www.teraswap.app'
const ROUTES = ['', '/docs', '/privacy', '/terms', '/status'] as const

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()
  return ROUTES.map((path) => ({
    url: `${BASE_URL}${path}`,
    lastModified,
    changeFrequency: path === '' ? 'daily' : 'monthly',
    priority: path === '' ? 1 : 0.7,
  }))
}
