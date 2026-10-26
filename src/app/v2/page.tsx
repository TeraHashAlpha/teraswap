import { notFound } from 'next/navigation'
import HomeV2 from '@/ui/v2/HomeV2'
import { getUiVersion } from '@/ui/v2/version'

// [ADR-025] The v2 home. Visitors reach it through proxy.ts (`/` → `/v2` rewrite when the switch says v2).
// proxy.ts already 404s direct hits; this check is defence in depth (a thrown notFound() here renders the
// 404 UI but cannot change the HTTP status — the root layout's ssr:false providers commit it first).
export const dynamic = 'force-dynamic'

export default async function V2Home() {
  if ((await getUiVersion()) !== 'v2') notFound()
  return <HomeV2 />
}
