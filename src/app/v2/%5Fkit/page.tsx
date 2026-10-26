import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { isV2KitEnabled } from '@/ui/v2/kit-gate'
import KitDemo from './kit-demo'

// [ADR-025] Dev kit — reachable only on Vercel Preview or `next dev`. Evaluated per request (not at build)
// so a preview build promoted to production cannot keep serving it. Folder is `%5Fkit` because Next treats a
// plain `_kit` folder as private (never routed); the URL is /v2/_kit.
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'v2 kit', robots: { index: false, follow: false } }

export default function KitPage() {
  if (!isV2KitEnabled()) notFound()
  return <KitDemo />
}
