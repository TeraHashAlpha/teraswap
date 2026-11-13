# Feedback: fix/link-preview-image

Goal: new link-preview card (C1), stale words around it (C2). No PR, CI not polled. Auditor not required (copy + one static file).

- [x] C1 image + generator `scripts/og-image/build.mjs` + layout.tsx references/alt + `layout.og-image.test.ts`
- [x] C2 manifest strings, guards (`metadata.copy.guard.test.ts`, em-dash net 4), old card archived
- [ ] Verify + evidence (section "Evidence", filled last)

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
