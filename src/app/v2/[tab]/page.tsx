import { notFound } from 'next/navigation'
import { AppShell } from '@/ui/v2/shell'
import { V2_TABS } from '@/ui/v2/shell/tab-paths'
import { getUiVersion } from '@/ui/v2/version'

// [ADR-025] The 8 app tabs: proxy.ts rewrites `/<tab>` → `/v2/<tab>` under the switch, and this ONE generic route mounts
// the shell for it (panes are Skeletons until the B2+ pages land). Same defence in depth as /v2: proxy.ts already 404s
// direct hits; a non-tab segment or a v1 request here is a notFound() (UI only — the proxy owns the HTTP status).
export const dynamic = 'force-dynamic'

export default async function V2TabPage({ params }: { params: Promise<{ tab: string }> }) {
  if ((await getUiVersion()) !== 'v2') notFound()
  const { tab } = await params
  const match = V2_TABS.find((t) => t.path === `/${tab}`)
  if (!match) notFound()
  return <AppShell tab={match.id} />
}
