# chore/next-font-local — feedback

- [x] C1 inventory · [x] C2 self-host · [x] C3 guard · [x] verify

## 1. Inventory before
Only importer of `next/font/google`: `src/app/layout.tsx`. Variables set on `<html>`; consumed by
`tailwind.config.ts` (sans/display/mono) and `globals.css` body — unchanged.
Inter: latin, 400-800, swap, `--font-inter` · JetBrains Mono: latin, 400/500/600, swap, `--font-mono`.

## 2. Files added (`src/fonts/`, see README there for URLs/hashes/OFL)
- Inter v4.1 `InterVariable-latin.woff2` 105,176 B — c06b669f…a952 (upstream variable, latin-subset with
  fonttools; unsubset was 352 KB, which pushed total to 618 KB > 600 KB limit)
- JetBrains Mono v2.304 Regular/Medium/SemiBold woff2 (92,164 / 93,824 / 94,472 B) — a9cb1cd8…45f2 / 086c48df…a353 / 918edad5…faf1
  (v2.304 variable font is TTF-only, so static woff2 for the 3 weights in use)
- Total woff2: 385,636 B ≈ 377 KB (+ two OFL.txt, README). Inter weight range now `100 900` (superset of 400-800).

## 3. Offline build
`https_proxy/HTTP_PROXY=http://127.0.0.1:9 npm run build` → exit 0 (curl through same proxy: connection refused).
Output CSS/HTML: 0 refs to fonts.gstatic/googleapis; 4 woff2 served from `/_next/static/media/`.

## 4. Guard + CSP
`__tests__/no-next-font-google.test.ts` — fails on layout.tsx with the google import (verified), passes now.
CSP unchanged: it lives in `next.config.js` (goal named `src/lib/security-headers.ts`, which doesn't exist);
`font-src 'self' data: https://cdn.fontshare.com` has no Google origins, so nothing to remove.

## 5. Checks
tsc clean · lint 94 warnings/0 errors (= baseline 94) · vitest 4402 pass vs origin/main(e4b2def) 4401 (+1 guard).

## Deviations / notes
- Fonts in `src/fonts/` not `public/fonts/`: `next/font/local` emits to `/_next/static/media/`, so built CSS never
  says `/fonts/`; public/ would hold unused duplicates.
- Not touched: Clash Display preload from cdn.fontshare.com (runtime browser fetch, not build-time).
