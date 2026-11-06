# Feedback — chore/audit-gate-decode-uri-component (GHSA-qr28-fpjm-wq7f, no PR)

- [x] facts · [x] fix by the rule (allowlist, patch < 7 d) · [x] verify

## 1. Facts (2026-10-29, base `320cc26`)
| Dependents | `wagmi` › `@wagmi/connectors` › `@walletconnect/ethereum-provider` › `@walletconnect/utils` › `query-string@7.1.3` (single path) |
|---|---|
| Current | `0.5.0` (existing `overrides` pin, left untouched) |
| Patched | `0.5.1`, only fix; range `<=0.5.0`; published 2026-10-23T12:48Z |
| Age | 6.3 d < `min-release-age=7` → allowlist, no pin; expiry 2026-10-30 |
| audit | fixAvailable `wagmi@3.7.9` (semver-major), not taken |

## 2. Exact diff (`audit-allowlist.json`; package.json/lockfile untouched)
```diff
+    {
+      "id": "GHSA-qr28-fpjm-wq7f",
+      "package": "decode-uri-component",
+      "vulnerableRange": "<=0.5.0",
+      "fixedIn": "0.5.1",
+      "added": "2026-10-29",
+      "expires": "2026-10-30",
+      "reason": "Patched 0.5.1 was published 2026-10-23T12:48Z, so it is under .npmrc min-release-age=7 until 2026-10-30T12:48Z and cannot be installed yet. Single path: wagmi > @wagmi/connectors > @walletconnect/ethereum-provider > @walletconnect/utils > query-string@7.1.3; currently forced to 0.5.0 by an existing overrides pin. Reachability: client-side only (a DoS of the user's own tab); not assessed beyond the dependency path. Re-check on 2026-10-30: bump the overrides pin to 0.5.1 and delete this entry."
+    }
```

## 3. audit-gate (exit 0) + `npm ls decode-uri-component --all`
```
audit-gate: 2 high/critical advisories present, 2 allowlisted, 0 blocking.
  ALLOWLISTED  HIGH     decode-uri-component (GHSA-qr28-fpjm-wq7f) — fix 0.5.1, ages in undefined
  ALLOWLISTED  HIGH     zod (GHSA-mrhx-c7xc-m3w5) — fix none for 3.x (4.6.6 only), ages in undefined
audit-gate PASSED — no un-allowlisted high/critical advisories.
teraswap@0.1.0 └─ wagmi@2.19.5 › @wagmi/connectors@6.2.0 › @walletconnect/ethereum-provider@2.21.1
  › @walletconnect/utils@2.21.1 › query-string@7.1.3 › decode-uri-component@0.5.0 overridden
```
("ages in undefined" cosmetic, pre-existing: zod entry has no `ageInOn` either.)

## 4. Suite / build / lint (both measured; pkg+lock identical)
| | origin/main | branch |
|---|---|---|
| `npm test` | 377 files / 6068 pass | 377 / 6068 pass |
| lint | 0 err / 93 warn | 0 / 93 (delta 0) |
| audit-gate | FAILED | PASSED |

`npm run build` completes. `git diff --stat origin/main`: allowlist +9, this file new.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/audit-gate-decode-uri-component
After 2026-10-30T12:48Z: bump override to `0.5.1`, delete the entry.
