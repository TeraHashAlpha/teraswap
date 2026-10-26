# Feedback — chore/audit-gate-undici

Bump `overrides.undici` 7.29.1 -> 7.30.1 (GHSA-xjj6-f33q-929c). Dependency-only; no allowlist change; no PR.

## 1. Advisory
- Advisory: "undici vulnerable to Denial of Service via unhandled error on excessive content-encodings", High, CVSS 7.5.
- Affected `>= 7.18.0, < 7.30.1` (also `>= 6.23.0, < 6.29.1`, `>= 8.0.0, < 8.12.2`); patched 7.x = **7.30.1** (first patched 7.x).
- Brief said "7.0.0-7.30.0"; advisory says >= 7.18.0. Owner answer (26 Oct): record the advisory range as authoritative. No impact on the pin: 7.29.1 is inside both.
- npm registry: 7.30.1 published 2026-10-15T14:18Z; today 2026-10-26 = 11 days >= `min-release-age=7`. (Advisory page dates: NVD Oct 15, GH DB Oct 23.)

## 2. audit-gate
```
audit-gate: 1 high/critical advisory present, 1 allowlisted, 0 blocking.
  ALLOWLISTED  HIGH     zod (GHSA-mrhx-c7xc-m3w5) — fix none for 3.x (4.6.6 only), ages in undefined
audit-gate PASSED — no un-allowlisted high/critical advisories.
```

## 3. Copies
- `npm ls undici --all`: one copy, `jsdom@29.1.1 -> undici@7.30.1 overridden` (dev).
- `contracts/order-engine/package-lock.json` (untouched): `node_modules/undici` **6.29.0**, vulnerable; patched 6.29.1 (matches the Dependabot PR). Needs its own branch.

## 4. Verification
- `npm install` + `npm ci` clean under repo .npmrc; lock diff = undici version/resolved/integrity only.
- Measured on both (origin/main 3a97f76 vs branch): vitest 312 files / 4880 tests pass on both; tsc exit 0 on both; lint 93 warnings, 0 errors on both (delta 0); `npm run build` exit 0 on branch.
- `git diff --stat origin/main`: package.json, package-lock.json, this file.
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/audit-gate-undici
