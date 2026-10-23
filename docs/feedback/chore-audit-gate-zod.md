# chore/audit-gate-zod — feedback

Goal: clear CI `audit` (HIGH zod GHSA-mrhx-c7xc-m3w5). Dependency/allowlist only. No PR.

## Tasks
- [x] Advisory checked → patched 4.6.6 only, no 3.x patch → Commit 2 applies
- [x] C1 `overrides."zod@^4": "4.6.6"`, `npm install`, clean `npm ci`; `braces` entry dropped (564fc58)
- [x] C2 allowlist the two 3.x copies, expires 2026-11-22 (8bfbcb9)
- [x] Verify (below)

## Evidence
1. **Advisory** (github.com/advisories/GHSA-mrhx-c7xc-m3w5): "Zod can exhaust memory while validating oversized constrained collections", High 8.2, affected `< 4.6.6`, patched `4.6.6`. No 3.x range/patch listed. npm: 4.6.6 = 2026-10-11 (≥7d), last 3.x = 3.25.76 (2025-07-08).
2. **`npm ls zod --all`** before → after: root 4.x `4.3.6` → `4.6.6` (porto, eslint-plugin-react-hooks, zod-validation-error, abitype@1.2.3); `@coinbase/cdp-sdk` `3.25.76` and `@reown/appkit-wallet` `3.22.4` unchanged. Lockfile delta = the single `node_modules/zod` node.
3. **Gate**: `audit-gate: 1 high/critical advisory present, 1 allowlisted, 0 blocking.` → `audit-gate PASSED`.
4. **Checks** (branch vs origin/main baseline, both fresh `npm ci`): vitest 312 files / 4868 tests, 0 fail on both; tsc clean; lint 93 warnings on both (delta 0); `npm run build` OK. `npm audit --omit=dev`: 22 (11 moderate, 11 high) on both — the 11 highs are this one advisory propagated up from the two 3.x copies.
5. **diff --stat** (origin/main..HEAD): audit-allowlist.json, docs/feedback/…, package-lock.json (+3/−1), package.json (+2/−1). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/audit-gate-zod

## Findings
### Assumption that turned out wrong
- Brief named two 4.x consumers; the root 4.x copy also serves `abitype@1.2.3` (viem) and `zod-validation-error`. Nested overrides under porto/eslint-plugin-react-hooks would have left those on 4.3.6. Used one range-keyed root override `"zod@^4"` instead: npm matches edges that can resolve to 4.x, so the 3.x edges (`^3.25.76`, exact `3.22.4`) are untouched (proven in item 2).

### Concern
- Gate prints `ages in undefined` for the new entry (`scripts/audit-gate.mjs:69` reads `ageInOn`, which only exists for the min-release-age use case). Cosmetic; script left untouched (out of scope). Adding `ageInOn` would wrongly trigger the STALE nudge.
- Pre-existing, unchanged: `npm ls` exits ELSPROBLEMS (`abitype@1.0.8` peer `^3` resolved to root zod 4.x). Same before and after.
- Allowlist expires 2026-11-22; re-check weekly for a 3.x patch or cdp-sdk / appkit bumps.
