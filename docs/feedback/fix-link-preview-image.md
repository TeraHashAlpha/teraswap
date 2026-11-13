# Feedback: fix/link-preview-image

Goal: new link-preview card (C1), stale words around it (C2). No PR, CI not polled. Auditor not required (copy + one static file).

- [x] C1 image + generator `scripts/og-image/build.mjs` + layout.tsx references/alt + `layout.og-image.test.ts`
- [x] C2 manifest strings, guards (`metadata.copy.guard.test.ts`, em-dash net 4), old card archived
- [x] Verify + evidence (section "Evidence")
- [x] Extra commits: CLAUDE.md/AGENTS.md state block regen (vitest 491 -> 493, CI `--check`); keep `ui/v2` paths out of a `src/app` test comment (v1 isolation test caught it)

## Premise check (origin/main 7e566fd, 2026-11-13)
- Confirmed: `public/og-image.png` 1200x630, 24 190 B, referenced twice in `layout.tsx`.
- Differs: the alt was already `TeraSwap: Ethereum Meta-Aggregator` (colon, no U+2014); `layout.tsx` has no U+2014 in any string (only in a comment), so C2 changed nothing there.
- Differs: `manifest.json` `screenshots[0].src` also pointed at `/og-image.png`, so it was not unreferenced. CLAUDE.md rule 4 forbids deleting: after repointing the manifest nothing referenced it, so it moved to `archive/public/og-image.png` (served URL `/og-image.png` now 404s; cached previews keep their own copy).

## Strings changed (before -> after)
- `layout.tsx` openGraph.images url / twitter.images: `/og-image.png` -> `/og-teraswap-v2.png`
- `layout.tsx` openGraph alt: `TeraSwap: Ethereum Meta-Aggregator` -> `TeraSwap: Compare. Verify. Swap. Repeat.`
- `manifest.json` description: `Ethereum meta-aggregator that queries 11 liquidity sources for the best swap rate, with multi-oracle protection and privacy proxy.` -> `SITE_META_DESCRIPTION` verbatim (3 chains, 8 sources; the test pins equality, so the count is derived)
- `manifest.json` screenshots[0] src `/og-image.png` -> `/og-teraswap-v2.png`; label `TeraSwap: Ethereum Meta-Aggregator` -> `TeraSwap: Compare. Verify. Swap. Repeat.`
- Left alone on purpose: manifest `name` "TeraSwap: DeFi Meta-Aggregator" (chain-neutral, true), layout `keywords` (not shown in previews; still lists 'Ethereum', 'Chainlink').

## Notes
- Judgement call: the wordmark and the four words are both cream; hierarchy is size only (230 px / 78 px), since the brief allows no other colour.
- `scripts/check-product-claims.mjs` does not scan `manifest.json`; the equality test is what keeps its count honest.

## Found, not fixed (outside the allowed change set)
- `src/lib/wagmiConfig.ts:117` `appDescription`: "Ethereum & Base meta-aggregator: best swap price across 11 liquidity sources." Wallet connect modals show it: same two lies (2 chains, 11 sources). Needs its own prompt.
- Other "MEV" text is the neutral docs/legal copy retired-claims allows (`DocsTabV2` "MEV & CoW Protocol", `LegalPageV2` risk list, `SourcesMenu` badges); no promise, left alone.

## Evidence
1. Image: `~/ts-worktrees/link-preview-image/public/og-teraswap-v2.png`, 1200x630, 45 098 B; 400 px downscale: `~/ts-worktrees/ts-evidence-link-preview/og-400.png` (not committed). Text boxes: wordmark x 160-1040, y 121-397; words x 163-1037, y 400-494 (safe area 80 px, asserted by the script).
2. Premise check: section above.
3. Strings: table above. Grep src+public, non-test files: "7 sources" 0, "Ethereum Meta-Aggregator" 0, "11 liquidity" 1 (`wagmiConfig.ts`, above), "MEV" only the neutral docs copy above; none in `layout.tsx` or `manifest.json` (guard-enforced).
4. `scripts/agent-verify.sh` @ 2ed8021: suite PASS 10596/0 (493 files), lint-delta +0/+0, tsc 0, build ok, v1v2-parity 111/0, rpc-budget 36/0; CodeQL/keeper not requested (no logic touched). `gen-claude-state.mjs --check` current; claims checker passed (0 hard-coded). Guards proven red by mutation (em dash + "MEV" injected in manifest -> both fail). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/link-preview-image
