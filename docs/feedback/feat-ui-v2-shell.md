# feat/ui-v2-shell — FEEDBACK
Off `d4b43db` (B0 merged). Commits `a0d2cf3` shell · `a7ac5c5` photos+fonts · `d9ef690` sounds+proxy+mobile · `7bc0079` fab fix. Files: `feat-ui-v2-shell/` (details: `NOTES.md`).
- [x] C1 · [x] C2 · [x] C3 · [x] verify · [x] evidence 1–7

**Owner answers (supersede goal):** one route file `src/app/v2/[tab]/page.tsx` · v1 proof = module-identical, byte-identical explicitly WAIVED by owner: "Yes, waived" (verbatim in `NOTES.md`) · Arbitrum text derives from `isDcaLive`.

1. **Screenshots** (`*.webp`; prod build, RPC mocked): desktop d1 header/tabs/footer, d2 dropdown, d3 Ethereum vs d4 Base tabs, d5 Arbitrum, d6 help, d7 connect;
   375 m1–m7 (m4: active tab in view, scrollLeft 431/774, fade L on/R off). Footer block follows the selected chain: d1 `ETHEREUM · BLOCK #23 541 870`, d4 `BASE · …36 612 405`, d5 `ARBITRUM ONE · …389 204 117`.
2. **Content-map delta** below: v2 ⊇ v1 except landing-only nav and the theme toggle (by design).
3. **Photos** 16 files (4 × AVIF/WebP × 1080/1920), max 197 204 B, test ≤ 200 000 B; credits.json (Evenden, Willbone, Dyllong, Gökdeniz / Pexels).
   Plates #0B0D0F@92%: body ≥ 4.61, large ≥ 6.54, hero on photo 7.44 (`contrast-plates.txt`). Veil 0.45 + band 96 px are tokens.
4. **Fonts** `pyftsubset` (fontTools 4.62.1, outside repo): Barlow 104 316→16 180 B · Plex 133 796→10 612 · 134 956→10 608 · 136 008→10 628 (all ≤ 60 KB).
5. **Sound parity** (real `sounds.ts`, mocked Audio): tab click=`playTouchMP3` · first click/key/scroll=`startBackgroundMusic` 0.08 loop · ♫=`toggleBackgroundMusic` only · others silent.
6. **Proxy** 65 tests. Real server, gate off: `/v2`, 8×`/v2/<tab>`, `/v2/_kit`, forged cookie → **404**; v1 pages 200; gate on: 8 tab paths 200 (`proxy-404-proof.txt`).
7. **Verify** vs origin/main `90eee44` (326 files/5077 tests): merged result 334/5263 ✓ clean merge · lint 93=93 · tsc 0 · `npm run build` ✓ · `check:*`×5 ✓ ·
   diff: 57 files `src/ui/v2/**`, proxy(+test), `[tab]` route, feedback; nothing in v1. v1: 0 v2 code in v1 chunks, Δ initial JS ≤ +605 B (chunk names differ; `NOTES.md`).
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-shell (no PR).

Open for owner: pack's 2nd footer sentence · 180 vs 160 ms toast · tagline now sr-only · v1 `useToast` vs `useV2Toast` in B3+ (see `NOTES.md`).

## Content-map delta (v1 → v2)
| v1 | v2 |
|---|---|
| Logo + tagline "Meta-Aggregator" | logo link, tagline `sr-only` |
| Landing nav (Performance…Docs, ☰, My Analytics) — landing only | not in shell (landing block; Analytics is a tab) |
| ThemeToggle | removed (dark only) |
| ChainSelector (icon, name, search, ✓, "Soon") | NetworkMenu (icon, name, subtitle, ✓, "Soon"); no search |
| Connect / address pill | same; lowercase `0x…4`+`…`+4 |
| WalletModal (ENS, address+copy, balance, network, via, Explorer/DeBank/Copy, Disconnect) | AccountPanel: all; network = selected chain; identicon ring dropped |
| Footer: Docs·GitHub·X·Fee·No infinite approvals·`<chain> · Block #N`·Privacy·Terms·Contact·©·TeraHelps·risk line | all present (Contact shows address); risk line verbatim |
| 8 ModeTabs, "Soon" via `isLimitLive` | 8 tabs; "Soon" only Limit/SL-TP; DCA never "Soon" + Ethereum gate |
| ♫, "?" + HelpDrawer (6 sections, X, support) | ♫, "?", drawer (same `helpSections`, search, pack labels) |
| ToastProvider (5 types, Etherscan link) | `V2ToastProvider` (same API, max 3, chain-aware link) |
| NotificationBanner | NoticeBanner (same hook + copy) |
| BetaBanner / BetaDisclaimer | not carried (no beta) |

## CI fixes (e5486de, fed1de1)
**Premise corrected (owner-approved fix: committed `.d.ts`).** Goal said the 16 photo files were missing from git. They are not: `git ls-files src/ui/v2/photos` = 16 `.avif`/`.webp` at `b6a660c` and at origin `085cb02`, names match `photos.ts`, `git check-ignore` matches none, not LFS. Largest = 197,204 B (<= 200 KB); no `.gitignore` change needed.
- **1. Cause of TS2307:** the `*.avif`/`*.webp` module types live in `next/image-types/global`, pulled in by `next-env.d.ts` (gitignored, `.gitignore:26`, written by `next dev/build`). Fresh checkout = no file = TS2307 x16. Reproduced with clean `npm ci` + `tsc`; clean with the file. Fix `fed1de1`: `src/ui/v2/photos/images.d.ts` = `/// <reference types="next/image-types/global" />`. `tsc --noEmit` exit 0 with no `next-env.d.ts`.
- **2. Escaper (`e5486de`):** old `s.title.replace(/[()/]/g, '\\$&')` (no `\`, no `. * + ? ^ $ { } | [ ]`) -> new `escapeRegExp` = `/[.*+?^${}()|[\]\\/]/g`. Rule is `js/incomplete-sanitization` in the pack (the `CWE-116/IncompleteStringEscaping.ql` path in the goal doesn't exist; used `Security/CWE-116/IncompleteSanitization.ql`). Local `scripts/codeql-local.sh`: before = 1 (`shell.test.tsx:297`), after = 0 repo-wide. Shell test 30/30.
- **3. Verify:** suite branch 340 files / 5341 pass vs origin/main (`2a30ad9`) 332 / 5155; lint 0 errors / 93 warnings on both (delta 0); `tsc` clean; `npm run build` exit 0. New commits touch only `shell.test.tsx`, `images.d.ts`, this file. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-shell (PR #610 exists).
- **Edge:** any other tracked image import elsewhere relied on the same gitignored `next-env.d.ts`; none other flagged by CI.
