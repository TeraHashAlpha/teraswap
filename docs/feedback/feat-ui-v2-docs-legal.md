# Feedback — feat/ui-v2-docs-legal

Goal: bring Docs, Terms and Privacy into the v2 launch (all-or-nothing), round-7 language throughout.
Base: origin/main after feat/ui-v2-mobile-parity (#660), verified merged at `ff06085` before branching.

## Task checklist

- [x] C1: `/v2/docs|terms|privacy` pages + proxy matcher + metadata + v2 help drawer links
- [x] C2: Legal pages — wrapper-only restyle + the one approved copy change + parity test
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

## P2 — C2: Legal pages restyle + the one copy change (commit TBD)

### What shipped
- `src/components/LegalPage.tsx:131` (v1, the one approved edit): "However, no method of electronic transmission
  or storage is 100% secure." → "However, no system is completely secure." Rest of the sentence/paragraph
  untouched. Before/after:
  - Before: `However, no method of electronic transmission or storage is 100% secure. You are responsible for…`
  - After:  `However, no system is completely secure. You are responsible for…`
- `src/ui/v2/docs-legal/LegalPageV2.tsx` (new): Terms (20 sections) and Privacy (14 sections), text copied
  byte-for-byte from v1's `PrivacyPolicy()`/`TermsOfService()` (including the one edit above) — only the wrapper
  (`SectionTitle`/`SubTitle`/`P`/`UL`, container) is restyled: no box (local prose scrim, hairlines, round-7
  typography) in place of v1's `rounded-2xl` bordered panel. Container 2 (sticky TOC / scroll-spy): a text list
  with one hairline per item, active item cream, same IntersectionObserver rule as v1's DocsPage
  (`use-scroll-spy.ts`, shared with Docs in C3). Container 3 (local prose scrim): `docs-legal.css`'s
  `.ts-v2-prose-scrim`, the same `--scrim-left`/`--scrim-down` tokens the landing's `ts-v2-scrim` uses.
- `ContentShell.tsx` no longer passes `appScrim` to `PhotoBackground` (see judgement call below).
- `src/ui/v2/docs-legal/content-parity.legal.test.tsx` (new): v1 `LegalPage` vs v2 `LegalPageV2`, both types,
  `compareContent` with an EMPTY allow-list (the one copy change lands in v1 too, so nothing needs allowing) —
  green on the first run, plus an explicit assertion that neither version still says "100% secure".

### Judgement call
- Goal's container-3 decision says "local scrim, not the uniform app scrim" — I dropped `appScrim` entirely from
  `ContentShell` (not just added a local one on top). This is safe, not a contrast gamble: `photo-scrim.ts` gives
  all three reused photos (overpass, archnight, footbridge) a measured `photoScrim` of **0** — the baked
  grade + veil alone already clears AA for them — so `appScrim` was already a visual no-op on these three pages;
  removing it changes nothing measurable.

### Concern
- Duplicating ~2,230 words of legal prose into a second component (rather than having v2 import v1's content
  functions) is the same drift-risk pattern this codebase already accepts for Swap/DCA/Orders/etc. — guarded by
  the parity test, not by single-sourcing. `LegalPage.tsx` is marked read-only-source-of-copy in this goal, so
  refactoring it to export shared data was out of scope; flagging the tradeoff rather than silently taking it.
