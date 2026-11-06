// [feat/ui-v2-docs-legal] Same title/description as v1's /docs — re-exported, not retyped, so the two can never
// drift (a metadata-equality test pins this). proxy.ts rewrites /docs to this route under the v2 switch; the URL
// bar stays /docs, so sitemap.ts (which lists the public /docs URL) needs no change.
export { metadata } from '@/app/docs/layout'

export default function V2DocsLayout({ children }: { children: React.ReactNode }) {
  return children
}
