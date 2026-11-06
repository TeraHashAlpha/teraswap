/**
 * [feat/ui-v2-docs-legal] Docs/Terms/Privacy join the v1<->v2 switch: each has a REAL v1 page
 * (src/app/docs|terms|privacy), so under the switch they behave like /swap and /analytics in
 * tab-paths.ts — v2 rewrites to /v2<path>, v1 keeps its own page untouched. They are not app tabs
 * (no TabBar entry, no AppShell pane), so they are a path list of their own, not part of V2_TAB_PATHS.
 */
export const V2_DOCS_LEGAL_PAGES = ['docs', 'terms', 'privacy'] as const

export type V2DocsLegalPage = (typeof V2_DOCS_LEGAL_PAGES)[number]

export const V2_DOCS_LEGAL_PATHS: readonly string[] = V2_DOCS_LEGAL_PAGES.map((p) => `/${p}`)
