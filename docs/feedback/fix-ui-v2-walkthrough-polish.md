# Feedback: fix/ui-v2-walkthrough-polish

- [x] C1 sound button mutes ALL sound  - [x] C2 landing boundaries  - [x] C3 no em dash  - [x] verify

## 1. Mute (C1)
- `src/lib/sounds.ts`: one `soundEnabled` (default on). Off: 3 MP3 players, 10 synths, `startWaitingSound`,
  `startBackgroundMusic` return before any `Audio`/`AudioContext`; `toggleBackgroundMusic()` also stops the
  music and a playing waiting loop. No caller changed.
- v1 `BackgroundMusic` + v2 `MusicToggle`: "Mute sound" / "Unmute sound". v1 button got `data-v1-sound-toggle`
  (the v2 hide rule keyed on the old label suffix).
- Tests: `src/lib/sounds.mute.test.tsx` (table over every export, loop stop, back on, v1 button),
  `src/ui/v2/shell/sound-mute.test.tsx` (v2 button; v1 files may not import v2).

## 2. Landing (C2)
- Cause: hero, Performance, Why, CTA were `ts-v2-opaque` bands with a static still and no `data-ts-narrative`:
  they covered the photo stack, so their boundaries were hard cuts. Only the 5 long sections had the motion.
- Fix: all 9 sections are narrative sections; photos are stack layers (same files, veil, 900 ms; no new
  timing); `.ts-v2-rv` reveal; stack starts on the hero photo. Found on the real page: a short LAST section
  (docs) never reached the 40 % line at 1440x900 and stayed invisible: it now counts once wholly in view.
- Frames: `~/ts-worktrees/ui-v2-walkthrough-polish-frames/b{1,2,8}-*-{1440,375}-*.png` (prod build). Layer
  opacity out/in at +150/+450 ms. 1440: b1 .83/.17 .02/.98, b2 .80/.20 .01/.99, b8 .87/.13 .02/.98.
  375: b1 .94/.06 .15/.85, b2 .94/.06 .17/.83, b8 .96/.04 .27/.73. Reduced motion paints statically as before.
- Tests: every `main > section` has `data-ts-narrative`, none opaque; contrast re-run for all 9 sections.

## 3. Em dash (C3)
- Visitor-facing string nodes (AST, comments skipped): 484 in 107 files -> 0 (5 left: 4 `console.*`, 1
  exempt privacy note). Biggest before/after: DocsPage 39/0, DocsTabV2 39/0, SwapBox 24/0, DcaCard 22/0,
  DCAPanel 21/1 (console). All 107 rows: `fix-ui-v2-walkthrough-polish.em-dash-counts.md` (too long for
  one screen). Empty value `n/a` (your call), spaced range "to", asides commas, never a hyphen.
- 10 samples: "Swap blocked — oracle data unsafe." -> "Swap blocked: oracle data unsafe." | "paused — your
  existing ones keep running" -> "paused. Your existing ones keep running" | "routing — you get whichever" ->
  "routing. You get whichever" | "Every other route — APIs (Curve) — is a public-mempool tx" -> "route, APIs
  (Curve), is" | "exchange rate — likely a depeg" -> "rate, likely a depeg" | "instead — it checks each buy"
  -> "instead. It checks each buy" | "TeraSwap — The Gold Standard" -> "TeraSwap: The Gold Standard" |
  "Aggregation value: —" -> "...: n/a" | `${a} – ${b}` -> `${a} to ${b}` | "then sign — no infinite
  approvals" -> "then sign: no infinite approvals".
- Guard `src/ui/v2/__tests__/no-em-dash.guard.test.tsx`: AST scan + claims/help values + renders of v1 /docs,
  v2 /v2/docs (3 chains), v2 landing. The render net found DISABLED_SOURCES reasons on Docs (fixed).
  ONE exemption `PRIVACY_TERMS_EXEMPT` (privacy/terms pages, layouts, `PRIVACY_*` claims); its comment names
  `fix/privacy-no-usage-tracking` as the branch that removes it.
- Left on purpose: 4 `console.*` logs; API routes, monitors, alerts (no API change); calldata-recipient/decoder
  and post-execution-validator reasons (gates, error-toast text only). Other routes: AST net only, not rendered.

## Further reads (beyond the goal's list)
NarrativeStack/narrative tests, photos/PhotoCredit + Footer, DocsPage, lib/constants.ts, agent-verify.sh,
check-product-claims, gen-claude-state: needed to move the 4 stills into the stack, keep credits, and verify.

## 4. Verify (agent-verify.sh --codeql, base 0062400)
suite 10368 pass/0 fail | lint +0/+0 (60/60) | tsc 0 | build ok | parity 111 | rpc-budget 33 | CodeQL 13 vs
13, 0 new | gen-claude-state --check ok | claims checker ok | 296 files, +2267/-1567 | no PR opened.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/ui-v2-walkthrough-polish
