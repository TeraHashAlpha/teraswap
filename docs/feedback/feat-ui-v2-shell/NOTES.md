# feat/ui-v2-shell — notes (appendix to ../feat-ui-v2-shell.md)

## Owner answers (asked; supersede the goal text)
- **Route file:** `/<tab>` → `/v2/<tab>` needs a page → ONE generic `src/app/v2/[tab]/page.tsx` (+test); only file outside `src/ui/v2/**`/proxy/feedback.
- **v1 proof = module-identical, not file-identical.** The shell shares wagmi/RainbowKit + v1 hooks (goal-mandated), so Turbopack regroups chunks on every
  static v1 page. Measured: 0 v2 markers in any v1-loaded chunk; v1 source diff empty; route table = base + `/v2/[tab]`; initial JS Δ ≤ +605 B raw /
  +939 B gz per page (`/status`,`/admin` ±0). My question said "same modules"; precisely, 1–4 small modules (e.g. `ChainIcon`, wagmi `useBlockNumber`)
  moved into initial chunk sets and some bodies re-concatenate (`v1-module-sets.txt`). File names differ → v1 users re-download those chunks.
- **Arbitrum DCA is dark** (`isDcaLive(42161)` false). Asked: derive from `isDcaLive` (chosen) vs literal spec text. Today Arbitrum reads "Swap" and the
  Ethereum gate "DCA runs on Base."; both become the spec text ("Swap · DCA", "…Base and Arbitrum One.") with no edit once its executor is live.

## Decisions / reads
- `useQuoteChainId` is in `src/hooks/useChainId.ts`. Out-of-list reads (none edited): `app/{page,swap/page,providers,layout}`, `ChainSelector`, `ChainIcon`,
  `lib/{chains/registry,format,constants,help-content}`, `order-engine/limit-launch`, `useOrderNotifications`, `next.config.js`, `tailwind.v2.config.ts`.
- Root `providers.tsx` also mounts v1 `ToastProvider` + `BackgroundMusic` around `/v2` → v2 has its own toast provider (same API) + `music.ts`; v1's ♫ is
  hidden under v2 by an aria-label CSS selector (pinned by test); the v2 ♫ `stopPropagation`s so v1's first-interaction listener can't un-mute it.
- Photos: `underpass-1920.webp` 203 178 B re-encoded to 191 292 B (strict 200 000 B). Only the 4 photos the tabs use ship. next/image `priority` not used
  (its preload targets the WebP `<img>` while AVIF browsers take the `<source>` → double hero download) → `<picture>` + eager + `fetchPriority=high`.
- Fonts: `pyftsubset` from a venv outside the repo (no dependency); Sonatype Guide MCP was unreachable (401) so the pre-install check could not run.
- `config.matcher` must be string literals (Turbopack rejects a spread; unit tests did not catch it, `npm run build` did) → literal + drift test.
- Screenshots: placeholder `NEXT_PUBLIC_*` at build (WC id, FeeCollectors, DCA flag, `*.alchemy.com`-host RPCs); RPC answered by a Playwright mock with the pack's sample
  block numbers. v1's CSP `connect-src` blocks v1's default public Base/Arbitrum RPCs (pre-existing; prod sets an allowed `*.alchemy.com` URL) — my first screenshots
  missed the Base/Arbitrum footer block for that reason, not a v2 bug. `next dev` rewrites `AGENTS.md` (restored, never committed).

## Concerns
- Shared v1 hooks that call v1 `useToast` in v2 pages (B3+) show v1-styled toasts; use `useV2Toast`. `sounds.ts` has no "enabled" getter: opening v2 after muting
  on a v1 page shows ♫ "on" (display only).
- New strings beyond pack/v1: aria-labels ("Turn music off/on", "Dismiss notification", "Open help", "Networks"). Pack's 2nd footer sentence ("Provided “as is”…"),
  the 180 ms toast motion (token is 160 ms) and the "Meta-Aggregator" tagline (now sr-only) are open for the owner.
- Dropdown shows v1's "Soon" chip for a chain without a FeeCollector (env-driven).
- Not run: Playwright e2e, security-review plugin. First parallel suite run hit one flaky `usePortfolio` test (3/3 green alone; no hook changes).
