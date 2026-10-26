import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { isV2EnableEnabled } from '@/ui/v2/kit-gate'
import EnableForm from './enable-form'

// [ADR-025] Preview opt-in — reachable only on Vercel Preview or `next dev` (404 elsewhere, like `_kit`). Evaluated per
// request so a preview build promoted to production cannot keep serving it. Folder is `%5Fenable` for the same reason
// as `%5Fkit`: a plain `_enable` folder is private to Next and never routed; the URL is /v2/_enable.
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'v2 enable', robots: { index: false, follow: false } }

export default function EnablePage() {
  if (!isV2EnableEnabled()) notFound()
  return <EnableForm />
}
