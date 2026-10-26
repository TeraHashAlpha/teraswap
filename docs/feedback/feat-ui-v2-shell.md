# feat/ui-v2-shell — FEEDBACK
Flow-B: code only in `src/ui/v2/**`, `src/proxy.ts`(+test), this file. Off origin/main `d4b43db` (B0 #606 merged: `src/ui/v2/version.ts` present).
- [x] C1 shell + feedback (a0d2cf3) · [x] C2 photos + fonts · [x] C3 sounds + proxy + mobile · [ ] verify · [ ] evidence 1–7

## Premises checked / decisions (recorded)
- `useQuoteChainId` is exported from `src/hooks/useChainId.ts` (no `useQuoteChainId.ts` file). Used as-is, read-only.
- **Arbitrum DCA is dark** (`isDcaLive(42161)` = false, `DCA_CHAINS` ≠ live). The dropdown subtitle and the Ethereum DCA gate
  ("DCA runs on …") are therefore driven by `isDcaLive` / `dcaLiveChainNames()`, not typed: today Arbitrum reads "Swap" and the gate
  says "DCA runs on Base."; both flip to the spec text ("Swap · DCA", "…Base and Arbitrum One.") with no edit when its executor is wired.
  Typing it now would publish a claim `product-claims.ts` exists to prevent. If the owner wants the literal text anyway, it is a 1-line change.
- Out-of-list reads (needed to mirror v1 faithfully; read-only, none edited): `app/{page,swap/page,providers,layout}.tsx`,
  `components/{ChainSelector,icons/ChainIcon}.tsx`, `lib/{chains/registry,chains/activation,format,constants,help-content}.ts`,
  `lib/order-engine/limit-launch.ts` (`isLimitLive`), `hooks/useOrderNotifications.ts` (`useNotificationPrompt`), `next.config.js` (images),
  `tailwind.v2.config.ts`, `package.json` (grep), pack `round4/desktop/30a` + `mobile/m05,m09`.
- Root `providers.tsx` wraps `/v2` in v1's `ToastProvider` + `BackgroundMusic` (v1-styled ♫). Not editable (Flow-B) → v2 ships its own
  toast provider (same API as v1) and ♫; see C3 for the v1-♫ handling.
- Photos: pack says "≤ 200 KB each"; 1 of 16 files (`underpass-1920.webp`, 203 178 B) was over a strict 200 000 B → re-encoded with sharp
  (q70, 191 292 B); the test asserts 200 000 B. Only the 4 photos the shell tabs use ship (zakim, underpass, arch-night, trails); arch-light
  (Docs/Legal/Status) and the unused highway are left out, `credits.json` is trimmed to match. `next/image` `priority` is NOT used: it would
  preload the WebP `<img>` while AVIF browsers use the `<source>` (double hero download) → `<picture>` + eager/`fetchPriority=high`.
- Fonts: `pyftsubset` (fontTools 4.62.1) from a venv outside the repo — no dependency added; Sonatype Guide MCP was unreachable (401) so the
  usual pre-install check could not run. Face sizes 509 076 B → 48 028 B (README table).
- **Owner answer (asked at C3; supersedes the Flow-B diff list): "Add one route file".** `/<tab>` → `/v2/<tab>` needs a page, so ONE generic
  `src/app/v2/[tab]/page.tsx` (+ test) is added — the only file outside `src/ui/v2/**` / `src/proxy.ts` / feedback. `/v2/_kit` stays a static
  segment (wins over `[tab]`); `/swap` and `/analytics` remain v1 pages for v1 visitors (the proxy rule only fires under the gate).
- Sounds: root `providers.tsx` also mounts v1's `BackgroundMusic` (document-level first-interaction listener + its own ♫) around `/v2`. v2
  keeps the same engine and adds `music.ts` (module-level `started`/`on`, because the shell remounts per tab page; v1's root never remounts).
  v1's ♫ is hidden under `[data-ts-ui="v2"]` by an aria-label selector (pinned by a test); the v2 ♫ `stopPropagation`s so v1's listener cannot
  restart music right after a mute. `sounds.ts` has no `isBackgroundMusicEnabled` export, so a v2 page opened after muting on a v1 page
  starts with ♫ "on" (display only; Flow-B forbids touching sounds.ts) — B3 follow-up if it matters.
- Pack: toast motion text says 180 ms, B0 token `--t-toast` is 160 ms (ARCHITECT_BRIEF.md:24) → token kept. Pack footer carries a second
  sentence (“Provided as is…”) that is not in v1's `Footer` and not in the verbatim list → omitted; owner to decide.

## Content-map delta (header / footer, v1 → v2) — filled at verify
