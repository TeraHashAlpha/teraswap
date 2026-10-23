# chore/audit-gate-zod — feedback

Goal: clear CI `audit` (HIGH zod GHSA-mrhx-c7xc-m3w5). Dependency/allowlist only.

## Tasks
- [x] Advisory checked: patched = 4.6.6 only, no 3.x range/patch → Commit 2 applies
- [x] C1: `overrides."zod@^4": "4.6.6"`, `npm install`, clean `npm ci`; drop resolved `braces` allowlist entry
- [ ] C2: allowlist the two unpatched 3.x copies (expires 2026-11-22)
- [ ] Verify: gate, build, tsc, suite vs main, lint delta, diff --stat

## Findings
### Assumption that turned out wrong
- Brief named two 4.x consumers (porto, eslint-plugin-react-hooks); the root 4.x copy also serves
  `abitype@1.2.3` (viem) and `zod-validation-error@4.0.2`. Nested overrides would have left those on 4.3.6.
  Used one range-keyed root override `"zod@^4"` instead: npm matches it on edges that can resolve to 4.x, so
  the 3.x edges (cdp-sdk `^3.25.76`, appkit-wallet `3.22.4`) are untouched — proven by `npm ls zod --all` below.
