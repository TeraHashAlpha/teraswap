# Feedback — chore/audit-gate-decode-uri-component

Goal: unblock `node scripts/audit-gate.mjs` (HIGH `decode-uri-component` GHSA-qr28-fpjm-wq7f). No PR.

- [x] C1 facts
- [x] C2 fix by the rule (allowlist — patch < 7 d)
- [x] verify (audit-gate, suite, build, lint)

## 1. Facts (measured 2026-10-29 ~19:20 WET, base `320cc26`)

| Item | Value |
|---|---|
| Dependents | `wagmi@2.19.5` → `@wagmi/connectors@6.2.0` → `@walletconnect/ethereum-provider@2.21.1` → `@walletconnect/utils@2.21.1` → `query-string@7.1.3` → `decode-uri-component` (single path) |
| Current version | `0.5.0` (lockfile; already forced by existing `overrides` pin `"decode-uri-component": "0.5.0"`) |
| Advisory range | `<=0.5.0` (HIGH, CWE-400/407) |
| Patched version | `0.5.1` — only patched release (versions: …0.4.1, 0.5.0, 0.5.1) |
| Patched published | 2026-10-23T12:48:46Z |
| Patch age | 6.3 d (< `.npmrc` `min-release-age=7`) → allowlist, do NOT pin |
| Expiry | 2026-10-30 (patch date + 7 d) |
| `npm audit` fixAvailable | `wagmi@3.7.9` (semver-major) — not taken |

Note: the existing `0.5.0` pin is left untouched (it is the vulnerable version; 0.5.1 is not yet installable).
After 2026-10-30T12:48Z: bump the override to `0.5.1` and delete the allowlist entry.

## 2. Diff (`audit-allowlist.json` only; `package.json` untouched, no pin added)

```diff
+    {
+      "id": "GHSA-qr28-fpjm-wq7f", "package": "decode-uri-component",
+      "vulnerableRange": "<=0.5.0", "fixedIn": "0.5.1",
+      "added": "2026-10-29", "expires": "2026-10-30",
+      "reason": "Patched 0.5.1 … under min-release-age=7 until 2026-10-30T12:48Z … Re-check on 2026-10-30: bump the overrides pin to 0.5.1 and delete this entry."
+    }
```

## 3. audit-gate (exit 0) + `npm ls`

```
audit-gate: 2 high/critical advisories present, 2 allowlisted, 0 blocking.
  ALLOWLISTED  HIGH     decode-uri-component (GHSA-qr28-fpjm-wq7f) — fix 0.5.1, ages in undefined
  ALLOWLISTED  HIGH     zod (GHSA-mrhx-c7xc-m3w5) — fix none for 3.x (4.6.6 only), ages in undefined
audit-gate PASSED — no un-allowlisted high/critical advisories.
```
`npm ls decode-uri-component --all` → single path … `query-string@7.1.3` → `decode-uri-component@0.5.0 overridden`.
("ages in undefined" is cosmetic, pre-existing: the zod entry has no `ageInOn` either.)

## 4. Suite / build / lint

- `npm test`: 377 files, 6068 tests pass (same counts as origin/main `320cc26`; diff is JSON + docs only, no code).
- `npm run build`: completes. `npm run lint`: 0 errors, 93 warnings (delta 0 vs recorded baseline 93).
- `git diff --stat origin/main`: `audit-allowlist.json` +10, feedback file new.
