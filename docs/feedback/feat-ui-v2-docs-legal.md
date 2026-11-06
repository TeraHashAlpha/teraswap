# Feedback — feat/ui-v2-docs-legal

Goal: bring Docs, Terms and Privacy into the v2 launch (all-or-nothing), round-7 language throughout.
Base: origin/main after feat/ui-v2-mobile-parity (#660), verified merged at `ff06085` before branching.

## Task checklist

- [x] C1: `/v2/docs|terms|privacy` pages + proxy matcher + metadata + v2 help drawer links
- [x] C2: Legal pages — wrapper-only restyle + the one approved copy change + parity test
- [x] C3: Docs page — full restyle (six containers) + scroll-spy + tables + claims-live + a11y
- [x] C4: Mobile 375 (overflow test, TOC collapse) + screenshots 375/1440
- [x] Verify: suite vs origin/main, lint delta 0, tsc clean, build, v1 module-identical, rpc-budget, CodeQL 0 new
- [x] Evidence 1–6 in this file, branch pushed, compare link reported

## P1 — C1: routing, shells, metadata, help drawer (`bd2b6d5`)

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

## P2 — C2: Legal pages restyle + the one copy change (`8542053`)

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

## P3 — C3: Docs full restyle, six containers, claims-live, a11y (`471f75d`)

### What shipped
- `src/ui/v2/docs-legal/DocsTabV2.tsx` (new, ~1000 lines): full restyle of v1's 1029-line DocsPage, text
  byte-for-byte identical (a parity test proves it — see Concern/Edge case below for the one real bug it caught).
  Six owner-approved containers: (1) `DocTable` — hairline rows, no box/fill; (2) sticky TOC / scroll-spy — text
  list, hairline per item, active cream (`use-scroll-spy.ts`, shared with Legal); (3) `.ts-v2-prose-scrim` — same
  local scrim as Legal; (4) `FlowDiagram` — a numbered 01-05 list, no boxes; (5) `SourceRow` — one hairline row
  per liquidity source; (6) `DocTag`/`ComingSoonBanner` — mono caps text / a strip with an amber accent. Every
  other repeating "numbered step" card (Smart Routing, Security, Order Engine, Limit, SL/TP, DCA, Split Routing,
  Analytics) reuses the same hairline-row shape — the general no-box rule, not a seventh owner decision.
- `src/ui/v2/docs-legal/content-parity.docs.test.tsx`: v1 `DocsPage` vs v2 `DocsTabV2`, real product-claims, two
  chain ids (1, 8453) — 200+ text nodes, 0 missing, 0 missing hrefs, **no allow-list** (see Edge case).
- `src/ui/v2/docs-legal/claims-live.docs.test.tsx`: all 29 product-claims symbols v1's DocsPage imports (count
  matches recon/docs-v2's "29 of 66") mocked to distinct fake values; every fake appears in v2's render — proves
  the slots are live reads, not hardcoded strings that happen to match today.
- `src/ui/v2/docs-legal/docs-legal-a11y.test.tsx`: heading order (h1 → h2 → h3, no skipped levels) for both Docs
  and Legal; every TOC button is a real, keyboard-focusable `<button>`; `scrollToSection` respects
  prefers-reduced-motion (instant jump, not animated).
- No framer-motion / scroll-reveal in `DocsTabV2` — a simplification, not asked for: v1's `whileInView` fades add
  nothing the goal requires, and the landing's own reveal mechanism (`ts-v2-rv`) is landing-scoped CSS/JS this
  tree doesn't share, so pulling it in would be new coupling for a purely decorative effect.

### Edge case (real bug caught and fixed, not just a design choice)
- First parity run failed: the shared `compareContent` allow-list helper strips an allow-listed substring from
  **every** v1 text node globally, not just the node it's meant for. An allow entry for the FlowDiagram's bare
  "→" (round-7 numbered list replacing it) also stripped the arrow out of the unrelated OpenOcean
  disabled-source message ("...returning 200 JSON for USDC→USDT..."), corrupting that comparison and failing
  the test. Fix: v2's `FlowDiagram` keeps a plain "→" text separator between its numbered rows (not a box, not
  a connecting line — just the same character v1 shows), so no allow-list entry is needed at all. Flagging this
  as a real sharp edge in `content-parity.ts` for whoever next needs an allow-list entry that is also a common
  substring elsewhere on the page.

### Judgement calls
- Added a (visually `sr-only`) `<h1>` to Docs — v1 has NO `<h1>` on this page at all. Additive only (parity only
  requires nothing be *removed*), and it's what let the a11y heading-order test mean anything on this page.
- `StepRow`'s title is `<h3>`, not v1's `<h4>` — v1 skips a heading level in every section that uses this card
  shape (`<h2>` SectionTitle directly to `<h4>` step titles, no intervening `<h3>`). Caught by my own a11y test;
  fixed in v2 only (v1 untouched, per the read-only-copy constraint).

### Concern
- `DocsTabV2` duplicates v1's prose (same risk noted for Legal in P2) — guarded by the parity test, which just
  proved its worth by catching a real drift risk (above), not a hypothetical one.

## P4 — C4: mobile 375, TOC collapse, screenshots (`ff4bde3`)

### What shipped
- `src/ui/v2/docs-legal/LegalPageV2.tsx` + `DocsTabV2.tsx`: below 1024 px the sticky sidebar TOC is NOT just
  hidden — it collapses to an in-page `<details>` list (summary "On this page" / "Documentation", same hairline
  rows, same `scrollToSection`), so mobile users still get a TOC. Covered by `docs-legal-a11y.test.tsx`.
- `src/ui/v2/__tests__/mobile/mobile.pw.ts`: added `docs`/`terms`/`privacy` to `ROUTES` (disconnected, chainId 1
  — these pages need no wallet). They get the SAME gates every other v2 route gets for free: no horizontal
  overflow, tap targets ≥ 44 px, reduced-motion (nothing animates forever), photo credit confined to the footer
  band, and `V2_SHOTS_DIR` screenshots.
- `scripts/e2e-mobile-parity-ci.test.mjs` needed no change — it checks the suite runs in CI generically, not a
  per-route count.

### Real bug found and fixed by the gate (not a design choice)
- First real-Chromium run: `375 · docs › tap targets are at least 44 px` FAILED — the Support section's two
  standalone links ("@TeraHash on X", the support email) were ~20 px tall. Legal's equivalent links are inside
  running prose, so the WCAG 2.5.8 inline-text exception covers them; Docs' are their own row, outside running
  text, so the exception does not apply and the 20 px row was a real violation. Fixed: `inline-flex min-h-[44px]
  items-center` on both links (commit lands this before the evidence screenshots, so the shipped build is the
  fixed one). Rebuilt and reran: 15/15 pass.

### Evidence (screenshots)
- `docs/feedback/feat-ui-v2-docs-legal/{docs,terms,privacy}-{375,1440}.jpg` — real Chromium renders against
  `UI_V2_ENABLED=true next start`, from the SAME build the mobile gate ran green against (post tap-target fix).

## P5 — rpc-budget: close the Docs gap (`1cc8461`)

A `docs` state added to the `frontend-rpc-diet` harness (disconnected visitor, v1 `DocsPage` vs v2 `DocsTabV2`):
≤ 1 RPC call/min (the shared Footer's `eth_blockNumber` poll only — the same budget as `a0`/`a`), mount burst
≤ 4, hidden = 0. Closes the gap flagged in P1's "Test gap" note with a real enforced guard, not a code-review claim.

## Verification pass (evidence 1–6)

### 1. Proxy / metadata tests
- `src/proxy.test.ts`: new `describe('/docs, /terms, /privacy …')` block (12 cases) + updated matcher tests —
  v1 untouched with no/forged/secret-less cookie, v2 rewrite to `/v2<path>` under `UI_V2_ENABLED=true` or a valid
  cookie, and a direct `/v2/docs` hit is still a real 404 whatever the switch says.
- `src/app/v2/docs-legal-metadata.test.ts`: `v2 === v1` by reference (`toBe`) for all three routes' `metadata` —
  re-exported, not retyped, so title/description can never drift.

### 2. Parity output ×3 + the one sentence before/after
- `content-parity.legal.test.tsx` (privacy + terms) and `content-parity.docs.test.tsx`: all green, 0 missing
  text, 0 missing hrefs, 0 stale allow-list entries. Docs needed **no allow-list at all** (see P3's Edge case —
  the FlowDiagram arrow stays as plain text instead of being removed, after an allow-list collision bug).
  Legal's allow-list is also empty (the one copy edit lands in v1 too).
- The one approved copy change (`src/components/LegalPage.tsx:131`, lands in v1 AND is what v2 copies):
  - Before: `However, no method of electronic transmission or storage is 100% secure. You are responsible for…`
  - After:  `However, no system is completely secure. You are responsible for…`
  - Explicit test: `content-parity.legal.test.tsx` asserts both versions say "no system is completely secure"
    and neither says "100% secure".

### 3. Claims-live test
- `claims-live.docs.test.tsx`: all 29 `product-claims` symbols v1's DocsPage imports mocked to distinct,
  obviously-fake values (e.g. `97`, `ZZFAKE proxy-claim sentinel`); every fake appears in v2's render. Proves
  the slots are live reads, not strings that happen to match today's values.

### 4. Screenshots 1440/375 ×3
- `docs/feedback/feat-ui-v2-docs-legal/{docs,terms,privacy}-{375,1440}.jpg` — real Chromium (`src/ui/v2/__tests__/mobile/mobile.pw.ts`)
  against `UI_V2_ENABLED=true next start`. 15/15 gate tests green (overflow, tap targets, reduced motion, footer
  photo credits, screenshots) — after fixing a real 20px tap-target bug in the Docs Support section (P4).

### 5. v1 proof + rpc-budget + CodeQL
- **v1 module-identical**: `src/ui/v2/isolation.test.ts` passes — no source outside the switch / admin route /
  v2 routes references `ui/v2`, so v1's `/docs`, `/terms`, `/privacy` pages (untouched except the one approved
  LegalPage.tsx sentence) pull in zero v2 modules. `next build` route table confirms both routes are still
  marked `○` (Static) pre- and post-branch — same type as `/swap`, `/status` — nothing about v1's render mode
  changed. Build: `UI_V2_ENABLED=true NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<32 chars> npm run build` — succeeds,
  0 real errors (24 pre-existing "AVIF not supported" Turbopack warnings, unrelated to this branch — the same
  warning class every tab's `PhotoBackground` already triggers).
- **rpc-budget**: see P5 above — `docs` state green, ≤ 1 RPC/min, 0 while hidden.
- **CodeQL** (`javascript-security-extended.qls`, full suite, `gh codeql` 2.27.2): base (`ff06085`) = 13
  findings, head = 13 findings, **diff by ruleId:file:line = 0 new, 0 removed**. All 13 are pre-existing, in
  files this branch never touches (`src/app/api/orders/route.ts`, `src/lib/auth.ts`, `src/lib/api-auth.ts`,
  `src/lib/fingerprint-validator.ts`, `src/app/api/telegram/webhook/route.ts`, `scripts/capture-endpoint-baseline.ts`).

### 6. Suite / lint / tsc / build + diff --stat + compare link
- **Suite**: `npx vitest run` — 437 files / 7773 tests, **0 failures** (run twice: once after C1–C4, once after
  the rpc-budget commit — both green).
- **Lint**: `npm run lint` on head = 93 problems (0 errors, 93 warnings); on `ff06085` (base, throwaway
  worktree) = 93 problems (0 errors, 93 warnings) — **delta 0**, and none of the 93 are in this branch's files.
- **tsc**: `npx tsc --noEmit` clean after every commit.
- **Build**: `UI_V2_ENABLED=true NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<32 chars> npm run build` succeeds (run
  twice — once before, once after the tap-target fix).
- **diff --stat** (`ff06085..HEAD`): 37 files changed, 2285 insertions(+), 12 deletions(-).
- **Commits** (5, all SSH-signed, noreply committer):
  - `bd2b6d5` feat(ui-v2): route /docs, /terms, /privacy to the v2 shell
  - `8542053` feat(ui-v2): restyle Terms and Privacy to round-7, one approved copy edit
  - `471f75d` feat(ui-v2): full round-7 restyle of Docs, claims-live + a11y tests
  - `ff4bde3` feat(ui-v2): mobile 375 for Docs/Terms/Privacy, TOC collapse, 44px fix
  - `1cc8461` test(ui-v2): close the Docs rpc-budget gap (0 RPC of its own)
- **Compare link**: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-docs-legal

## Content-map delta (vs recon/docs-v2's inventory)

| Route | v1 containers | v2 treatment |
|---|---|---|
| /docs | 2 tables, sticky nav, FlowDiagram, SourceCard grid, ComingSoonBanner, Tag | hairline-row tables; TOC collapses to `<details>` below 1024px; FlowDiagram is a numbered 01-05 list; SourceCard is one hairline row; ComingSoonBanner is a strip+accent; Tag is mono-caps text |
| /terms, /privacy | boxed `rounded-2xl` panel, no TOC | wrapper-only restyle (text unchanged + the one approved sentence); a TOC was ADDED (v1 had none) — container 2, same scroll-spy as Docs |
| All three | reachable only from the v1 footer | ALSO reachable from the v2 help drawer ("Resources" block) — recon's reachability gap closed |

No owner decision from recon/docs-v2's "Owner decision needed" table (items 1–6) was left unresolved — all six
were answered in this goal's "Owner decisions (5 Nov)" section and implemented as specified (see P1–P4 above for
how each landed).
