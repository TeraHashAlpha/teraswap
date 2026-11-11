# Feedback: fix/ui-v2-walkthrough-polish

- [x] C1 the sound button mutes ALL sound (v1 and v2)
- [x] C2 landing: every section boundary moves the same way
- [x] C3 no em dash in visitor copy (v1 and v2) + guard
- [x] verify block and compare link (section 4)

## 1. Mute (C1)
- Engine `src/lib/sounds.ts`: one `soundEnabled` (default on). Off: the 3 MP3 players, the 10 Web Audio
  synths, `startWaitingSound` and `startBackgroundMusic` return before any `Audio`/`AudioContext` exists;
  `toggleBackgroundMusic()` stops music and a playing waiting loop. No caller changed.
- v1 `BackgroundMusic` and v2 `MusicToggle`: title + aria-label "Mute sound" / "Unmute sound". v1 button got
  `data-v1-sound-toggle` because the v2 hide rule in `shell.css` keyed on the old label suffix.
- Tests: `src/lib/sounds.mute.test.tsx` (table over every export, completeness check, loop stop, back on, v1
  button), `src/ui/v2/shell/sound-mute.test.tsx` (v2 button; v1 files may not import v2).

## 2. Landing (C2)
- Cause: hero, Performance, Why and the bottom CTA were `ts-v2-opaque` bands with a static `NarrativeStill` and
  no `data-ts-narrative`. They covered the fixed photo stack, so their boundaries were hard cuts (no photo
  fade, no reveal); only the 5 long-text sections had the approved motion.
- Fix: all 9 sections are narrative sections in page order (`NARRATIVE_SECTIONS`), photos are stack layers
  (same files, veil, 900 ms fade; no new timing), content carries `.ts-v2-rv`; the stack starts on the hero
  photo so first paint is not bare. Found on the real page: a short LAST section (docs) never reaches the 40 %
  line at 1440x900 and stayed invisible, so the last section is active and revealed once wholly in view.
- Frames (prod build, Chromium): `~/ts-worktrees/ui-v2-walkthrough-polish-frames/b{1,2,8}-*-{1440,375}-*.png`.
  Layer opacity outgoing/incoming at +150 ms, +450 ms: 1440 b1 .83/.17, .02/.98; b2 .80/.20, .01/.99; b8 .87/.13,
  .02/.98. 375 b1 .94/.06, .15/.85; b2 .94/.06, .17/.83; b8 .96/.04, .27/.73. Reduced motion: static painting kept.
- Tests: every `main > section` carries `data-ts-narrative`, none is opaque; contrast re-run for all 9 sections.

## 3. Em dash (C3)
- Visitor-facing string nodes (AST, comments skipped): 484 in 107 files -> 0; per file in
  `fix-ui-v2-walkthrough-polish.em-dash-counts.md` (kept out of here to stay one screen). Empty value = `n/a`,
  spaced date/fee range = "to", asides = commas, never a hyphen. Judgement call: the lone `—` placeholder is
  `n/a` (say if you want another word).
- Samples: "Swap blocked — oracle data unsafe." -> "Swap blocked: oracle data unsafe." | "Only new DCA orders are
  paused — your existing ones keep running." -> "...paused. Your existing ones keep running." | "...routing —
  you get whichever gives the better price" -> "...routing. You get whichever..." | "Every other route — APIs
  ... (Curve) — is a public-mempool transaction" -> "Every other route, APIs ... (Curve), is a ..." | "off its
  exchange rate — likely a depeg" -> "..., likely a depeg" | "...instead — it checks each buy" -> "...instead.
  It checks each buy" | "TeraSwap — The Gold Standard of DeFi Trading" -> "TeraSwap: The Gold Standard..." |
  "Aggregation value: —" -> "Aggregation value: n/a" | `${a} – ${b}` -> `${a} to ${b}` | "Approve once, then sign —
  no infinite approvals" -> "...sign: no infinite approvals".
- Guard `src/ui/v2/__tests__/no-em-dash.guard.test.tsx`: AST scan, claims + help values, renders v1 /docs,
  v2 /v2/docs (3 chains), v2 landing. The render net found DISABLED_SOURCES reasons on Docs (fixed).
  ONE temporary exemption `PRIVACY_TERMS_EXEMPT` (privacy/terms pages + layouts, `PRIVACY_*` claims), the
  comment names `fix/privacy-no-usage-tracking` as the branch that removes it. Left on purpose: 4 `console.*`
  logs, API routes/monitors/alerts (no API change), calldata-recipient/decoder and post-execution-validator
  reasons (gates: error-toast text only, "no change to gates"). Other routes: covered by the AST net only.

## 4. Verify
```
suite 10368 pass/0 fail (471 files) | lint +0 err +0 warn (60/60) | tsc 0 | build ok
v1v2-parity 111 pass | rpc-budget 33 pass | CodeQL security-extended 13 vs base 13, 0 new
gen-claude-state --check ok | check-product-claims ok | keeper not run (no keeper change)
296 files changed, 2267 insertions(+), 1567 deletions(-) (mostly one-line copy and test edits)
```
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/ui-v2-walkthrough-polish (no PR opened)
