# Feedback — feat/ui-v2-docs-legal

Goal: bring Docs, Terms and Privacy into the v2 launch (all-or-nothing), round-7 language throughout.
Base: origin/main after feat/ui-v2-mobile-parity (#660), verified merged at `ff06085` before branching.

## Task checklist

- [x] C1: `/v2/docs|terms|privacy` pages + proxy matcher + metadata + v2 help drawer links
- [ ] C2: Legal pages — wrapper-only restyle + the one approved copy change + parity test
- [ ] C3: Docs page — full restyle (six containers) + scroll-spy + tables + claims-live + a11y
- [ ] C4: Mobile 375 (overflow test, TOC collapse) + screenshots 375/1440
- [ ] Verify: suite vs origin/main, lint delta 0, tsc clean, build, v1 module-identical, rpc-budget, CodeQL 0 new
- [ ] Evidence 1–6 in this file, branch pushed, compare link reported

## P1 — C1: routing, shells, metadata, help drawer (commit TBD)

### What shipped
- `src/ui/v2/shell/docs-legal-paths.ts`: `V2_DOCS_LEGAL_PAGES`/`V2_DOCS_LEGAL_PATHS` (`docs`, `terms`, `privacy`).
- `src/proxy.ts` + `src/proxy.test.ts`: same rule as `/swap`/`/analytics` (real v1 page each, so v1 is untouched,
  v2 rewrites to `/v2<path>`) — not `V2_ONLY_TAB_PATHS` behavior (no redirect-to-home), and not an app tab (no
  TabBar entry). Matcher literals updated; a direct `/v2/docs` hit is still a real 404 under the gate.
- `src/ui/v2/photos/tab-photos.ts`: `DOCS_LEGAL_PHOTO` map (docs→overpass, terms→archnight, privacy→footbridge —
  owner's 5 Nov reuse-existing-tab-photos decision) + `photoForDocsLegalPage`, kept next to `TAB_PHOTO` (one place).
- `src/ui/v2/photos/PhotoBackground.tsx`: new optional `baked` prop (a `NarrativePhotoId` directly) alongside
  `tab`, for shell pages that are not one of the 8 tabs. Minimal, additive — no existing caller touched.
- `src/ui/v2/shell/ContentShell.tsx` (new): the v2 shell for these three pages — Header/Footer/Fabs, same chrome
  as `AppShell`, but no TabBar / tab-pane switch (v1's own Header on these pages is `showNav={false}` for the
  same reason: not an app tab).
- `src/ui/v2/shell/ContentPane.tsx` (new): Skeleton placeholder, same pattern as `TabPane` — replaced per-page in
  C2/C3.
- `src/app/v2/docs|terms|privacy/{page,layout}.tsx`: force-dynamic, `notFound()` under v1 (mirrors `/v2/[tab]`).
  Layouts re-export the v1 `metadata` object by reference (not retyped) — a test pins `toBe` equality, so the two
  can never drift; sitemap.ts is unchanged (same public URL either way).
- `src/ui/v2/shell/HelpDrawer.tsx` + `shell.test.tsx`: added a "Resources" block (Docs/Terms/Privacy links) — the
  drawer had none (recon/docs-v2 finding).

### Edge case
- The matcher-literal test (`proxy.test.ts` "the literal matcher … never drift apart") now slices the matcher
  array in two: tab paths at `[1,9)`, docs/legal paths at `[9,-2)`. Any future path group added to the matcher
  must keep this slicing in mind or the test will need a third slice.

### Test gap (tracked, not closed in C1)
- No rpc-budget scenario yet for a Docs/Terms/Privacy page load (goal evidence #5 "docs make 0 RPC calls") — the
  only RPC call any v2 shell page makes is the Footer's `eth_blockNumber` poll (shared, already budgeted
  elsewhere); a dedicated scenario is planned for the verification pass, not deferred indefinitely.
