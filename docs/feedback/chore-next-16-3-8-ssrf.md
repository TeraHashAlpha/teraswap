# chore/next-16-3-8-ssrf — feedback

`next` 16.3.6 → 16.3.8: closes HIGH GHSA-cjq9-62q9-8jv4 (SSRF, Image Optimization, `>=16.0.0 <16.3.8`)
+ GHSA-f87g/-mcj8/-3w37/-4jqv (moderate) + GHSA-39w2 (low). No other dependency changes.

## Checklist
- [x] C1 — evidence (this file)
- [ ] C2 — `next` bump in package.json + `npm install` (lockfile written by npm only)
- [ ] audit-gate PASS · build exit 0 · lint Δ0 · vitest count = origin/main
- [ ] push + compare link

## 1. `npm ls next` before/after + publish date
- Before (origin/main `2ae40d5`, `--package-lock-only`): `next@16.3.6` direct; `@sentry/nextjs@10.75.3` and
  `@vercel/analytics@2.0.1` dedupe to it.
- `overrides.next` = `{ "postcss": ">=8.5.10" }` — a nested scope override, not a version pin, so there is
  nothing to keep equal; left untouched.
- `npm view next time` (UTC): **16.3.8 = 2026-09-30T16:07:21Z → 10.3 d old** at 2026-10-10T22:53Z
  (≥ `.npmrc` `min-release-age=7` ✓). 16.4.0 = 2026-10-06T18:35Z (4.2 d) — not used.

## 4. Image Optimization surface (`next.config.js:6-11`, read-only, unchanged)
```js
images: {
  remotePatterns: [
    { protocol: 'https', hostname: 'tokens.1inch.io' },
    { protocol: 'https', hostname: 'assets.coingecko.com' },
  ],
},
```
No `domains`, no wildcard hosts, https only.
