# Sprint 29 — Performance Optimization

| Field | Value |
|---|---|
| **Goal** | Raise PageSpeed Performance score: Desktop 83→≥90, Mobile 52→≥65 |
| **Branch** | `perf/sprint-29-optimization` (from `main`) |
| **RICE** | R8 × I3 × C0.9 / E3 = **7.2** |
| **Prerequisite** | Sprint 28 merged ✅ |
| **Baseline** | Desktop: Perf 83, A11y 79, BP 92, SEO 100 · Mobile: Perf 52, A11y 87, BP 92, SEO 100 |

## Diagnosis Summary

**Root causes (from PageSpeed Insights 2026-05-26):**

1. **Render-blocking resources** — `@import url('https://fonts.googleapis.com/...')` in `globals.css` blocks first paint. Desktop: 260ms savings. Mobile: **2100ms savings**.
2. **Excessive JS execution** — 1.6s total (desktop), main chunk alone 1703ms CPU. Mobile LCP 8.4s driven by JS parsing on throttled 4G.
3. **No preconnect hints** — zero `<link rel="preconnect">` for external origins the page depends on (Google Fonts, Fontshare CDN, RPC endpoints).
4. **Bundle size** — 6.5MB raw / 1.7MB gzip across 191 chunks. viem alone ~600KB in two chunks. wagmi+rainbowkit 251KB.

**Not in scope:** ethers.js already removed from package.json. Accessibility improvements (separate sprint).

---

## P89 — Self-host Google Fonts (Inter + JetBrains Mono)

### Context
`globals.css` line 1 uses `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap')`. This is the single largest render-blocking resource — the browser must fetch CSS from `fonts.googleapis.com`, parse it, then fetch woff2 files from `fonts.gstatic.com`. On mobile 4G, this adds ~2100ms before any text paints.

### Objective
Self-host Inter and JetBrains Mono via `next/font/google`, eliminating the external CSS fetch entirely. Next.js automatically downloads fonts at build time and serves them from the same origin with optimal caching.

### Requirements
1. In `src/app/layout.tsx`, import `Inter` and `JetBrains_Mono` from `next/font/google`:
   ```ts
   import { Inter, JetBrains_Mono } from 'next/font/google'
   
   const inter = Inter({
     subsets: ['latin'],
     weight: ['400', '500', '600', '700', '800'],
     display: 'swap',
     variable: '--font-inter',
   })
   
   const jetbrainsMono = JetBrains_Mono({
     subsets: ['latin'],
     weight: ['400', '500', '600'],
     display: 'swap',
     variable: '--font-mono',
   })
   ```
2. Apply the CSS variables to the `<html>` tag: `className={\`dark ${inter.variable} ${jetbrainsMono.variable}\`}`
3. Remove the `@import url('https://fonts.googleapis.com/...')` line from `globals.css` (line 1).
4. In `tailwind.config.ts`, ensure `fontFamily.sans` maps to `['var(--font-inter)', ...defaultTheme.fontFamily.sans]` and `fontFamily.mono` maps to `['var(--font-mono)', ...defaultTheme.fontFamily.mono]`.
5. Update CSP in `next.config.js`:
   - Remove `https://fonts.googleapis.com` from `style-src`
   - Remove `https://fonts.gstatic.com` from `font-src`
   - Keep `https://cdn.fontshare.com` in `font-src` (Clash Display still external)

### Do NOT
- Remove Clash Display — it's the display/headline font loaded separately via `@font-face` with `font-display: swap` and preloaded in `layout.tsx`. It stays as-is.
- Change any font weights or font-family assignments beyond wiring the CSS variables.
- Remove the existing Clash Display `@font-face` block in `globals.css`.

### Files affected
- `src/app/layout.tsx` — add `next/font/google` imports, apply CSS variables to `<html>`
- `src/app/globals.css` — remove line 1 (`@import url(...)`)
- `tailwind.config.ts` — wire `--font-inter` and `--font-mono` to fontFamily
- `next.config.js` — tighten CSP (remove Google Fonts origins)

### Expected output
- Zero external CSS requests to `fonts.googleapis.com` at page load
- Inter and JetBrains Mono served from same origin via `/_next/static/media/`
- `font-display: swap` preserved (Next.js applies it by default)
- No visual change — same fonts, same weights
- 1 commit: `perf(fonts): self-host Inter + JetBrains Mono via next/font [P89]`

### Quality criteria
- `npm run build` succeeds with no warnings about missing fonts
- `npm run lint` clean
- `npm test` passes (no test changes expected)
- Visual inspection: text renders identically (same font, same weights)

---

## P90 — Add preconnect hints for critical external origins

### Context
The page depends on several external origins at load time: `cdn.fontshare.com` (Clash Display woff2), `*.supabase.co` (real-time subscriptions), WalletConnect relay, and Sentry. Currently there are zero `<link rel="preconnect">` hints — the browser discovers these origins only when it parses the CSS/JS that references them, adding ~100-200ms of DNS+TLS latency per origin.

### Objective
Add `<link rel="preconnect">` and `<link rel="dns-prefetch">` hints in `layout.tsx` `<head>` for the most critical external origins.

### Requirements
1. Add the following to `<head>` in `src/app/layout.tsx`, BEFORE the existing Clash Display `<link rel="preload">`:
   ```tsx
   {/* Preconnect — critical external origins */}
   <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="anonymous" />
   <link rel="dns-prefetch" href="https://cdn.fontshare.com" />
   ```
2. That's it. Do NOT preconnect to RPC or aggregator APIs — those are only needed post-wallet-connect and preconnecting to 15+ APIs would waste connections.

### Do NOT
- Add preconnect for every API in the CSP connect-src list
- Remove or modify the existing Clash Display `<link rel="preload">`
- Add preconnect for `fonts.googleapis.com` or `fonts.gstatic.com` — P89 removes them entirely

### Files affected
- `src/app/layout.tsx` — add 2 `<link>` tags in `<head>`

### Expected output
- DNS+TLS for `cdn.fontshare.com` starts immediately, ~100ms before the woff2 request
- 1 commit: `perf(preconnect): add hints for fontshare CDN [P90]`

### Quality criteria
- `npm run build` succeeds
- No CSP violations in browser console
- Clash Display still loads correctly

---

## P91 — Lazy-load LandingPage below-fold sections

### Context
`LandingPage.tsx` is imported statically in `page.tsx` (line 5). The entire component — including below-fold sections (features grid, stats counter, security section, footer CTA) — is parsed and rendered at initial load. On mobile, this contributes to the 8.4s LCP because the browser is executing JS for sections the user hasn't scrolled to yet.

### Objective
Split LandingPage's below-fold sections into a dynamically imported chunk that loads after the hero section is visible.

### Requirements
1. Extract the below-fold content from `LandingPage.tsx` into a new component `LandingBelowFold.tsx`:
   - Everything after the hero section (the first viewport — headline, subtitle, CTA buttons, hero stats)
   - This includes: features grid, stats counters, security section, source logos, and any footer CTA
   - The hero section stays in `LandingPage.tsx` for instant render
2. In `LandingPage.tsx`, dynamically import the below-fold component:
   ```ts
   const LandingBelowFold = dynamic(() => import('./LandingBelowFold'), {
     ssr: true,  // SSR the content for SEO
     loading: () => <div style={{ minHeight: '200vh' }} />,  // reserve scroll height
   })
   ```
3. Pass necessary props (any shared state, scroll refs, theme tokens) from `LandingPage` to `LandingBelowFold`.
4. The split point should be a clean component boundary — no shared mutable refs that would break across the dynamic import.

### Do NOT
- Touch the hero section — it must remain in the initial bundle for FCP/LCP
- Break the scroll-linked particle animation (it reads `scrollProgressRef` from the parent — ensure the ref is passed correctly)
- Change any visual appearance or animation timing
- Move the `ParticleNetwork` canvas or `ScrollSpy` components — they live in `page.tsx` and are unaffected

### Files affected
- `src/components/LandingPage.tsx` — extract below-fold, add dynamic import
- `src/components/LandingBelowFold.tsx` — NEW file with extracted sections

### Expected output
- Initial JS bundle shrinks by the size of below-fold sections (~30-50KB estimated)
- Hero section (FCP/LCP element) renders without waiting for features/stats/security sections to parse
- Below-fold sections load seamlessly before user scrolls to them (ssr: true means HTML is present, JS hydrates lazily)
- 1 commit: `perf(landing): lazy-load below-fold sections [P91]`

### Quality criteria
- `npm run build` succeeds, chunk analysis shows LandingBelowFold as a separate chunk
- `npm test` passes
- Visual inspection: landing page looks identical, smooth scroll to features section works
- No flash of missing content when scrolling — SSR ensures HTML is present

---

## P92 — Optimize viem tree-shaking and chunk splitting

### Context
Bundle analysis shows viem occupying ~600KB raw across two chunks — it's the single largest dependency. viem is designed for tree-shaking but Next.js's default chunk strategy may bundle unused modules (e.g., ENS resolution, contract simulation, L2 utilities) into the initial chunks.

### Objective
Configure Next.js to better split viem and wagmi chunks, and verify tree-shaking is working by auditing unused viem imports.

### Requirements
1. In `next.config.js`, add webpack configuration for better chunk splitting:
   ```js
   webpack(config) {
     config.optimization.splitChunks = {
       ...config.optimization.splitChunks,
       cacheGroups: {
         ...config.optimization.splitChunks?.cacheGroups,
         viem: {
           test: /[\\/]node_modules[\\/]viem[\\/]/,
           name: 'viem',
           chunks: 'all',
           priority: 30,
         },
         wagmi: {
           test: /[\\/]node_modules[\\/](@wagmi|wagmi|@rainbow-me)[\\/]/,
           name: 'wagmi',
           chunks: 'all',
           priority: 25,
         },
       },
     }
     return config
   },
   ```
2. Audit all `import` statements from `viem` across `src/` — list every imported function/type. Check if any of these pull in heavy sub-modules unnecessarily:
   - `viem/ens` — ENS resolution (unlikely needed, TeraSwap resolves via RPC)
   - `viem/chains` — may import all chains when only `mainnet` is needed
   - `viem/accounts` — private key accounts (not needed, wallet handles signing)
3. If any heavy sub-modules are imported but unused, replace them with more targeted imports:
   - `import { mainnet } from 'viem/chains'` instead of broad chain imports
   - Direct path imports where viem supports them
4. Ensure the Sentry webpack plugin (`withSentryConfig`) wraps the config AFTER the custom webpack changes (current code already does this correctly).

### Do NOT
- Remove any viem import that is actually used
- Change any runtime behavior — this is purely a build optimization
- Modify the Sentry configuration
- Add any new dependencies

### Files affected
- `next.config.js` — add `webpack()` with `splitChunks.cacheGroups`
- `src/**/*.ts(x)` — potentially narrow viem imports (audit first, change only if needed)

### Expected output
- viem and wagmi in dedicated named chunks instead of mixed into the main bundle
- Total bundle size reduction of ~50-100KB gzip (from better tree-shaking)
- 1 commit: `perf(bundle): optimize viem/wagmi chunk splitting [P92]`

### Quality criteria
- `npm run build` succeeds with no new warnings
- `npm test` passes (no runtime changes)
- `npm run build` output shows `viem` and `wagmi` as named chunks
- All swap functionality works correctly (manual test with wallet connect)

---

## Status

| # | Prompt | Status | Commit |
|---|--------|--------|--------|
| P89 | Self-host Google Fonts | TODO | — |
| P90 | Preconnect hints | TODO | — |
| P91 | Lazy-load below-fold | TODO | — |
| P92 | viem/wagmi chunk splitting | TODO | — |

## Architect Notes

1. **ethers.js is already gone** — `package.json` has no ethers dependency. The bundle analysis label "ethers+wagmi+rbk" was misleading — that chunk is purely wagmi + rainbowkit internals. No purge needed.
2. **P89 is the highest-impact single change** — render-blocking Google Fonts import accounts for 260ms desktop / 2100ms mobile. `next/font/google` eliminates this entirely with zero visual change.
3. **P90 is minimal but free** — preconnect for fontshare.com costs nothing and shaves ~100ms off Clash Display load.
4. **P91 targets mobile LCP specifically** — the 8.4s LCP is partially caused by parsing JS for 1200+ lines of below-fold content. Code splitting the landing page should reduce initial parse time by ~30%.
5. **P92 is exploratory** — the splitChunks config may or may not yield significant savings depending on how Next.js already splits chunks. The Code Agent should run `npm run build` before and after, comparing the `.next/analyze` or chunk sizes in build output. If savings are <20KB gzip, the cacheGroups config adds complexity for little gain — document in FEEDBACK.md and we can revert.
6. **Order matters** — P89 first (biggest win, smallest risk), then P90 (trivial), then P91 (moderate refactor), then P92 (exploratory). If P92 causes issues, the other three already deliver the bulk of the improvement.
7. **CSP update in P89 is security-relevant** — removing Google Fonts origins from CSP tightens the attack surface. Verify no other feature depends on `fonts.googleapis.com` or `fonts.gstatic.com`.
8. **Measurement gate** — after all 4 prompts, run PageSpeed Insights on `https://www.teraswap.app` (both desktop and mobile). If Desktop < 85 or Mobile < 60, file a FEEDBACK.md entry with the remaining bottlenecks for Sprint 30.
