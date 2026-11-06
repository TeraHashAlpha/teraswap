import { notFound } from 'next/navigation'
import { ContentShell } from '@/ui/v2/shell/ContentShell'
import { LegalPageV2 } from '@/ui/v2/docs-legal/LegalPageV2'
import { getUiVersion } from '@/ui/v2/version'

// [feat/ui-v2-docs-legal] proxy.ts rewrites /privacy → /v2/privacy under the switch; a direct hit or a v1
// request here is a notFound().
export const dynamic = 'force-dynamic'

export default async function V2PrivacyPage() {
  if ((await getUiVersion()) !== 'v2') notFound()
  return (
    <ContentShell page="privacy">
      <LegalPageV2 type="privacy" />
    </ContentShell>
  )
}
