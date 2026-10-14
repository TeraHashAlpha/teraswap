# chore/next-font-local — feedback

## Owner answers (recorded)
- `src/lib/security-headers.ts` doesn't exist; CSP is in `next.config.js` → accepted.
- Reads outside list accepted: tailwind.config.ts, globals.css, vitest.config.*, repo/.next greps.
- Added scope: self-host anything loaded from cdn.fontshare.com and drop it from CSP.

## 1. Inventory before
`next/font/google` only in `src/app/layout.tsx`: Inter (latin, 400-800, swap, `--font-inter`), JetBrains Mono
(latin, 400/500/600, swap, `--font-mono`); consumers tailwind `sans/mono/display` + globals.css body.
Runtime CDN: Clash Display `@font-face` (globals.css, wght 400-800) + preload/preconnect (layout.tsx) → cdn.fontshare.com.

## 2. Files (`src/fonts/`; URLs, full SHA-256, licences in `src/fonts/README.md`)
- Inter v4.1 variable, latin-subset: 105,176 B · c06b669f…a952 (unsubset 352 KB would be 618 KB total > 600 KB)
- JetBrains Mono v2.304 Regular/Medium/SemiBold: 92,164 / 93,824 / 94,472 B (variable is TTF-only upstream)
- Clash Display variable (Fontshare zip, wght 200-700): 29,428 B · dbe4b338…a662
- Total 415,064 B ≈ 405 KB. Licences: Inter/JBM = OFL 1.1; Clash = ITF FFL 2.0, §01: "You may self-host the Font
  Software on your own servers or infrastructure for use on your own websites and applications, including through
  standard webfont technologies such as CSS @font-face."

## 3. Offline build
`https_proxy/HTTP_PROXY=http://127.0.0.1:9 npm run build` → exit 0 (curl via same proxy refused). 5 woff2 emitted to
`/_next/static/media/` (not `/fonts/`: next/font/local bundles src files). 0 fontshare/gstatic/googleapis refs in our CSS/HTML.
Only hit: a wallet-modal lib chunk injects a Google Fonts `@import` at runtime; not ours, already blocked by CSP.

## 4. Guard + CSP
`__tests__/no-next-font-google.test.ts` (2 tests; +1 display-font test, 3 new total): no `next/font/google` under src/ (fails on old layout, verified);
no `fontshare` in layout/globals/tailwind/next.config.
CSP diff: `font-src 'self' data: https://cdn.fontshare.com` → `font-src 'self' data:`; also removed dead
`https://cdn.fontshare.com` from `connect-src` (fonts don't use connect-src). No existing CSP test referenced it.

## 5. Checks
tsc clean · lint 94 warn/0 err (= baseline) · vitest 4403 pass (origin/main 4401; +2 guards) · diff --stat vs origin/main: 15 files, +448/-31.

## Visual change: none (owner decision)
Old Clash Display URL 404s today, so production headlines render Inter. Per owner, tailwind `display` stays
`['var(--font-inter)', 'sans-serif']`; Clash Display (29 KB) is self-hosted but unapplied (`preload: false`, comment:
"reserved for the visual redesign; not applied"). `__tests__/display-font-is-inter.test.ts` pins this.
Final: tsc clean · lint 94 (= baseline) · vitest 4404 pass.
