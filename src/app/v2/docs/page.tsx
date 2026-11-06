import { notFound } from 'next/navigation'
import { ContentShell } from '@/ui/v2/shell/ContentShell'
import { DocsTabV2 } from '@/ui/v2/docs-legal/DocsTabV2'
import { getUiVersion } from '@/ui/v2/version'

// [feat/ui-v2-docs-legal] proxy.ts rewrites /docs → /v2/docs under the switch; a direct hit or a v1 request here
// is a notFound() (UI only — the proxy owns the HTTP status, same defence-in-depth as /v2/[tab]).
export const dynamic = 'force-dynamic'

export default async function V2DocsPage() {
  if ((await getUiVersion()) !== 'v2') notFound()
  return (
    <ContentShell page="docs">
      <DocsTabV2 />
    </ContentShell>
  )
}
