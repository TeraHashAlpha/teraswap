# feat/ui-v2-landing-scroll — feedback

Branch off origin/main `cc30627` (B2, #614). Flow-B only: `src/ui/v2/**` + this file. No PR (owner opens it). All 4 commits SSH-signed, noreply.

## Checklist
- [x] C1 photo stack + cross-fade · [x] C2 entrance + reduced motion · [x] C3 credit/icons/contrast · [x] verify

## Owner answers (asked mid-run; supersede the goal text)
1. **Motion tokens** were not in `tokens.css` (only `--t-toast/-shimmer`) → added `--ease-out/-inout`, `--t-fast/-base/-slow/-underline` (pinned in `tokens.test.ts`, zeroed under reduced motion). 2. **Photos:** only Underpass existed → the 20 `round6 bg-*` files copied to `photos/narrative/`, credits in `credits.json` (`narrative`).

## Evidence
1. **Map** — desktop: Security→Highway (Yeshtokyn) · Experience→Footbridge (Mclean) · Features→Tunnel (Николаевич) · Roadmap→Arch-in-light (wal_ 172619) · Docs→Underpass (Willbone). Mobile ≤600: Highway · Highway · Tunnel · Tunnel · Underpass (3 photos).
2. `narrative.test.tsx` (20): picker on mocked rects (40 % line, pre-select, none-visible), 21-step IO ladder, no scroll/wheel listener, scroll 0 → 0 `bg-*` in the DOM, `image-set(avif, webp)` only when near, one active layer, credit follows, mobile ≤3 photos; CSS pins: only `opacity` on `--t-slow`/`--ease-inout`, veil constant .176. Chrome: each section → its photo; 0 `bg-*` requests at scroll 0.
3. `narrative-motion.test.tsx` (24) + `landing.test.tsx` markup (+7): once (unobserve), deep link/jump-over shown, stagger 0·40·80·120·160 then 160, 12 px/`--t-base`/`--ease-out`, underline 600 ms after `--t-base`; reduced motion / each of the 3 flat queries (matchMedia mock, incl. runtime toggle). Chrome (RM, forced-colors, contrast:more): no stack; RM paints photo+veil per section, lazily (0 requests at scroll 0); flat: 0 `bg-*`.
4. Desktop credit fixed right 32 / bottom 70, `z-index 12` (z-10 content wrapper hid it behind cards — fixed). ≤600: floating credit hidden; footer band has a second line listing the 5 photographers. ♫ → `icons/MusicSpeaker` (inline, 20 px, on/off, well-formed XML), tests in `icons/` + shell.
5. `narrative-contrast.test.ts` (18): 28 states (veiled shipped photos via sharp, P95; 5+3 photos, 6 cross-fades in both layer orders, AVIF+WebP). Worst: muted body **5.87** · text body 12.93 · cream body **6.79** · text large 7.82 · cream large 11.11 · credit on plate 4.61 (white) · panels 5.08–15.49 · flat 5.51–16.79. 0 fails.
6. `next start`, Chrome, 7 runs/side: LCP desktop **336→332 ms**, mobile **332→332** (limit +100). Image bytes at scroll 0 identical: **362,202** desktop / **198,499** mobile (same 3 files; both sides sometimes refetch the hero once, pre-existing).
7. v1: diff outside `src/ui/v2/**`+this file **0 files**; 0 v2 markers in v1 chunks/HTML (positive control: found in v2 chunks); v1 initial JS 16,438,933 B = 16,438,933 B (Δ 0.000 %); route table identical. Suite 348/5499 → **352/5575**; lint 93 = 93 (0 errors); tsc 0; build 0. 44 files, +1615/−52. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-landing-scroll

## Owner decision / concerns
- **"One line" credit at ≤600 is not physically possible:** 5 names need ≈630 px at 9 px; measured **3 lines at 320–375, 2 at ≥414** (one element, footer band only). Options: keep · list only the 3 narrative names · smaller type.
- Underline = left→right `clip-path` reveal (CSS cannot set `pathLength`). B2's Docs h2 has no underline (prototype had); copy untouched.
- Chrome cannot emulate `prefers-reduced-transparency` here; covered by mocks + the CSS block it shares with the two verified queries.
- Pre-existing, not touched: at 375 the fixed ♫/? sit over card text; hero photo double-fetch race.
- Read extras: `primitives/{HandUnderline,Panel}`, `proxy.ts`+`ui-cookie.ts` (`UI_V2_ENABLED=true` for `next start`), `shell/{Footer,music}`, build needs a dummy `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.
