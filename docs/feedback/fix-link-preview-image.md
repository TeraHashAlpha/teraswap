# Feedback: fix/link-preview-image

Goal: new link-preview card (commit 1), stale words around it (commit 2). No PR, CI not polled.

- [x] C1 image, generator `scripts/og-image/build.mjs`, layout.tsx references + alt, `src/app/layout.og-image.test.ts`
- [ ] C2 manifest.json strings, layout.tsx strings, guards (em dash, "MEV")
- [ ] Verify: `scripts/agent-verify.sh`, `gen-claude-state.mjs --check`, claims checker
- [ ] Evidence 1-4 (below, filled at the end)

## Premise check (origin/main 7e566fd, 2026-11-13)
- Confirmed: `public/og-image.png` 1200x630 (24 190 B); referenced twice in `layout.tsx` (openGraph.images, twitter.images).
- Differs: the alt was already `TeraSwap: Ethereum Meta-Aggregator` (colon, no U+2014).
- Differs: `public/manifest.json` also references `/og-image.png` (`screenshots[0].src`), so the old file was not unreferenced.
