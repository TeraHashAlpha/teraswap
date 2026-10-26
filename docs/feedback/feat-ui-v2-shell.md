# feat/ui-v2-shell — FEEDBACK
Off origin/main `d4b43db` (B0 #606 merged; `src/ui/v2/version.ts` present). Commits: `a0d2cf3` shell · `a7ac5c5` photos+fonts · `d9ef690` sounds+proxy+mobile · `7bc0079` footer/fab fix.
- [x] C1 · [x] C2 · [x] C3 · [x] verify · [x] evidence 1–7 · Raw outputs + screenshots: `docs/feedback/feat-ui-v2-shell/`

## Owner answers (asked; supersede the goal text) and decisions
- **Route file:** `/<tab>` → `/v2/<tab>` needs a page → ONE generic `src/app/v2/[tab]/page.tsx` (+test) added; the only file outside `src/ui/v2/**`/proxy/feedback.
- **v1 proof = module-identical, not file-identical.** The shell shares wagmi/RainbowKit + v1 hooks (goal-mandated), so Turbopack regroups chunks.
  Measured: 0 v2 markers in any chunk any static v1 page loads; v1 source diff empty; route table = base + `/v2/[tab]`; initial JS Δ ≤ +605 B raw /
  +939 B gz per page (`/status`,`/admin` ±0). **Correction to my question:** I said "same modules" — precisely, 1–4 small modules (e.g. `ChainIcon`,
  wagmi `useBlockNumber`) moved into initial chunk sets and some bodies re-concatenate (`v1-module-sets.txt`). File names differ → v1 users re-download.
- **Arbitrum DCA is dark** → dropdown subtitle + Ethereum DCA gate are driven by `isDcaLive`/`dcaLiveChainNames()`: today Arbitrum "Swap", gate "DCA runs on Base."; flips to the spec text with no edit once live.
- `useQuoteChainId` lives in `src/hooks/useChainId.ts`. Out-of-list reads (none edited): `app/{page,swap/page,providers,layout}`, `ChainSelector`, `ChainIcon`, `lib/{chains/registry,format,constants,help-content}`, `order-engine/limit-launch`, `useOrderNotifications`, `next.config.js`, `tailwind.v2.config.ts`.
- Root `providers.tsx` also mounts v1 `ToastProvider` + `BackgroundMusic` around `/v2` → v2 ships its own toast provider (same API) + `music.ts`; v1's ♫ is hidden under v2 by aria-label selector (pinned by test).

## Evidence
1. **Screenshots** (prod build, gate on; RPC mocked with the pack's sample blocks; `*.webp` here): desktop `d1` header/tabs/footer · `d2` dropdown · `d3` tabs Ethereum (DCA gate) vs `d4` Base · `d5` Arbitrum · `d6` help · `d7` connect (RainbowKit themed); 375: `m1` `m2` dropdown `m3` Ethereum DCA `m4` active tab in view (scrollLeft 431/774, fully visible, fade L on / R off) `m5` Base `m6` footer `m7` help. Base/Arbitrum footer block did not render in this env (no reachable chain RPC → hidden, never mainnet's); per-chain block + explorer is unit-tested.
2. **Content-map delta** below (v2 ⊇ v1 except landing-only nav and theme toggle, by design).
3. **Photos** 4 × (AVIF+WebP)×(1080,1920) = 16 files, max 197 204 B (test ≤ 200 000 B; `underpass-1920.webp` 203 178 → 191 292 B re-encoded q70); `credits.json`: Evenden/Willbone/Dyllong/Gökdeniz, Pexels; `<picture>` AVIF + next/image WebP, eager+`fetchPriority=high` (next/image `priority` would preload the WebP, double download). Veil 0.45 / band 96 px tokens. Plates #0B0D0F@92%: body min 4.61 (dim on plate over white; 5.35 over graded photo), large min 6.54; hero text on photo 7.44 (`contrast-plates.txt`).
4. **Fonts** `pyftsubset` (fontTools 4.62.1, venv outside repo, no dep; Sonatype MCP unreachable): Barlow Bold 104 316→16 180 B · Plex Regular 133 796→10 612 · Medium 134 956→10 608 · Bold 136 008→10 628 (509 076→48 028 B; all ≤ 60 KB).
5. **Sound parity** (real `sounds.ts`, mocked `Audio`; `sound-parity-results.txt`): tab click = `playTouchMP3` (touch.mp3 0.5) · first click/key/scroll = `startBackgroundMusic` (0.08, loop, once) · ♫ off/on = `toggleBackgroundMusic` (pause / restart) · ♫ only toggles music (tab sound still plays muted) · help/network/connect = silent · waiting/quote-received/confirm/cancel not imported by the shell (B3/B5).
6. **Proxy** 65 tests (matrix ×8 tabs: no env/forged/secret-less cookie → v1 untouched; env/valid cookie → `/v2/<tab>`; direct `/v2/*` → `/v2-disabled`). Real server, gate off: `/v2`, 8 × `/v2/<tab>`, `/v2/_kit`, forged cookie → **HTTP 404**; v1 `/ /swap /analytics /docs` 200, no v2 marker; gate on: 8 tab paths 200 (`proxy-404-proof.txt`). Caught by the build, not unit tests: `config.matcher` must be literals (spread rejected) → literal + drift test.
7. **Verify** (vs merge-base build): suite 331 files / 5231 tests ✓ (base 323 / 5045) · lint 93 = 93 · tsc 0 · `npm run build` ✓ · `check:*` ×5 ✓ · `git diff --stat`: 57 files `src/ui/v2/**`, proxy(+test), `src/app/v2/[tab]` (owner-approved), feedback; nothing in v1. First parallel suite run hit one flaky `usePortfolio` test (passes 3/3 alone; 0 hook changes). Not run: Playwright e2e, security-review. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-shell (no PR; CI runs once the owner opens it).

## Concerns / owner notes
- Shared hooks calling v1 `useToast` in v2 pages (B3+) show v1-styled toasts; use `useV2Toast`. `sounds.ts` has no "enabled" getter: opening v2 after muting on a v1 page shows ♫ "on" (display only).
- Env (screenshots only): placeholder `NEXT_PUBLIC_*` (WC id, FeeCollectors, DCA flag, `.invalid` RPCs) at build; nothing committed. `next dev` rewrites `AGENTS.md`; restored, not committed.
- New strings beyond pack/v1: aria-labels ("Turn music off/on", "Dismiss notification", "Open help", "Networks"). Pack's 2nd footer sentence ("Provided “as is”…"), 180 ms toast motion and "Meta-Aggregator" tagline (now sr-only) are open for the owner.
- Dropdown shows v1's "Soon" chip for a chain without a FeeCollector (env-driven) — truthful in Preview envs lacking the Base/Arbitrum vars.

## Content-map delta (v1 → v2)
| v1 element (file) | v2 | Note |
|---|---|---|
| Logo "TERASWAP" + tagline "Meta-Aggregator" (Header) | logo link `/`, tagline `sr-only` | pack 01 has no visible tagline |
| Landing nav Performance/Security/Experience/Features/Docs, mobile ☰, "My Analytics" (Header `showNav`, landing only) | not in app shell | landing header = later block; Analytics is a tab |
| ThemeToggle | removed | dark only (D3) |
| ChainSelector: icon, name, ▾, search, listbox, ✓, "Soon" chip, mobile sheet | NetworkMenu: icon, name, ⌄, subtitle, ✓, "Soon" chip | search removed (pack r3 A2) |
| Connect / `displayName` + green dot | same; ENS or lowercase `0x…4`+`…`+4 | pack number spec |
| WalletModal: ENS name/avatar, address+copy, balance, network, Connected via, Explorer/DeBank/Copy, Disconnect | AccountPanel: all of these; network = selected chain | v1 hardcodes "Ethereum Mainnet"; identicon ring + brand micro-footer dropped (decor) |
| Footer: Docs · GitHub · X · Fee · No infinite approvals · `<chain> · Block #N` (explorer) · Privacy · Terms · Contact · © · TeraHelps · risk line | all present, same hrefs/aria; Contact shows the address; "Fee 0.1%" (no colon) | block = selected chain, 12 s poll, hidden tab paused |
| Risk line | `Smart contracts have not been externally audited. Use at your own risk.` | verbatim, test = v1 const = literal |
| ModeTabs 8 modes, "Soon" via `isLimitLive` | 8 tabs, "Soon" only Limit/SL-TP via `isLimitLive`; DCA never "Soon" | Ethereum DCA gate (pack 30a) |
| BackgroundMusic ♫ (↔ ✕), HelpButton "?" + HelpDrawer (6 sections, X, support) | ♫ + "?" + drawer (same `helpSections`, pack labels "Email support"/"@TeraHash on X", search) | v1 ♫ hidden under v2 |
| ToastProvider (5 types, 5-cap, Etherscan link) | V2ToastProvider (same API, max 3 visible per pack 05, chain-aware "View on explorer ↗") | |
| NotificationBanner | NoticeBanner (same hook + copy) | |
| BetaBanner / BetaDisclaimer | not carried | D2 no beta |
