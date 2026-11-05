# Recon: /docs, /terms, /privacy under the v2 flag

Base: origin/main e66fb45. Read-only; no source, copy, PR or v1/v2 component changed.

## Premise check
- CONFIRMED: `src/proxy.ts` matcher is `/`, the 8 tab paths, `/v2`, `/v2/:path*`. `/docs`, `/terms`, `/privacy` are not rewritten, so they render v1 with the flag on.
- CONFIRMED: the v2 shell footer (`src/ui/v2/shell/Footer.tsx:56,87,91`) links to `/docs`, `/privacy`, `/terms` on all 8 tabs. The v2 landing header and CTA also link to `/docs`.
- NOT FOUND: "backlog 68" (the "100% secure" wording). Searched the repo, the round-7 pack and the Desktop project folder. The wording exists at `src/components/LegalPage.tsx:131`. Owner to point at the backlog item.

## Inventory

| Route | Title | ~Words | Components | Links out | Claims (symbols) | Last changed |
|---|---|---|---|---|---|---|
| /docs | Documentation \| TeraSwap | ~1,500 | 2 tables, sticky scroll-spy nav (lg+), FlowDiagram, SourceCard, ComingSoonBanner, Tag; 0 code, 0 images, 0 forms, 0 accordions, 0 SVG | x.com/TeraHash, mailto | 29 of 66 | 13ef651 · 2026-10-23 |
| /terms | Terms of Service \| TeraSwap | ~1,300 | LegalPage prose (20 sections); 0 tables/code/images/forms | mailto, x.com | 3 (shared with /privacy) | 59cb405 · 2026-10-23 |
| /privacy | Privacy Policy \| TeraSwap | ~930 | LegalPage prose (14 sections) | mailto, x.com | 3 (shared) | 59cb405 · 2026-10-23 |

Word counts are estimates from a JSX-text scan (about ±15%). Claims are distinct `@/config/product-claims` symbols imported. The total is 30 across the three files, with 2 shared.

## Reachability from the v2 shell
- /docs, /privacy, /terms: reachable from the footer on every tab. /docs is also reachable from the landing header and CTA.
- The v2 help drawer does not link to any of them.

## Recommendation: (a), with the DocsPage tables and TOC routed to owner approval
- Legal pages: wrapper-only restyle, copy byte-identical (about 3 commits, plus a rendered-text parity test).
- /docs: a full rewrite of a 1,028-line component, roughly 10 commits. Needs owner approval for the containers listed in the report.
- Routing: add the 3 paths to `proxy.ts` and the matcher, and add `/v2/docs|terms|privacy` pages that keep route metadata.
- Estimate: about 12–15 commits total.

## Feedback
- Concern: `proxy.ts` has no `/docs`, `/terms`, `/privacy` rewrite; the footer links to them on every v2 tab.
- Concern: "backlog 68" not located; the "100% secure" copy is at `LegalPage.tsx:131` and must not change.
- Edge case: `/docs` and the legal routes export route-level metadata from their layouts. A v2 route must keep those titles and descriptions.
- Edge case: `DocsPage` uses the `product-claims` values (DISABLED_SOURCES, chain labels), so any restyle must keep them live.

| Owner decision needed (not in FUNCTIONAL-CONTAINERS.md) | Element |
|---|---|
| 1 | Data tables (2 in /docs) |
| 2 | Sticky TOC / scroll-spy nav |
| 3 | Long prose on the photo: local scrim vs app scrim |
| 4 | FlowDiagram (boxed nodes and arrows) |
| 5 | SourceCard grid (cards, unboxed by the rule) |
| 6 | ComingSoonBanner and Tag (map to item 14 / none) |
