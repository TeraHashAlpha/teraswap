# Feedback — chore/audit-gate-follow-redirects

Measured 2026-10-31 ~11:30–12:00 WET, base origin/main `9096dc5`, `.npmrc` min-release-age=7. No PR (owner opens).

## 1. Facts

| Package | Installed | Advisory (range → patched) | Patch published | Age | Action |
|---|---|---|---|---|---|
| follow-redirects | 1.16.1 (exact `overrides` pin) | GHSA-mrwp-f3q8-3g9p `>=1.16.0 <=1.16.1` → **1.16.2** | 2026-10-25T21:32Z | 5.6 d (<7) | allowlist, expires 2026-11-01 |
| decode-uri-component | 0.5.0 (`overrides` pin) | GHSA-qr28-fpjm-wq7f `<=0.5.0` → **0.5.1** | 2026-10-23T12:48Z | 7.9 d (≥7) | override → 0.5.1; allowlist entry deleted |

Single path each: wagmi > @wagmi/connectors > @base-org/account > @coinbase/cdp-sdk > axios@1.20.0 > follow-redirects; wagmi > @wagmi/connectors > @walletconnect/ethereum-provider > @walletconnect/utils > query-string@7.1.3 > decode-uri-component.

## 2. Diff
- `package.json` overrides: `"decode-uri-component": "0.5.0"` → `"0.5.1"` (follow-redirects pin untouched at `1.16.1`).
- `audit-allowlist.json`: removed GHSA-qr28-fpjm-wq7f; added GHSA-mrwp-f3q8-3g9p (follow-redirects, fixedIn 1.16.2, added 2026-10-31, expires 2026-11-01, same shape as the zod entry).
- `package-lock.json`: only decode-uri-component version/resolved/integrity (3 lines), via `npm install --package-lock-only`.

## 3. Gate + npm ls
```
audit-gate: 2 high/critical advisories present, 2 allowlisted, 0 blocking.
  ALLOWLISTED  HIGH  follow-redirects (GHSA-mrwp-f3q8-3g9p) — fix 1.16.2
  ALLOWLISTED  HIGH  zod (GHSA-mrhx-c7xc-m3w5) — fix none for 3.x (4.6.6 only)
audit-gate PASSED — no un-allowlisted high/critical advisories.   (exit 0)
```
`npm ls` after `npm ci`: only `follow-redirects@1.16.1` (allowlisted) and `decode-uri-component@0.5.1` (patched), one path each.

## 4. Verification
- vitest: 395 files / 6271 tests passed (equals the 395/6271 recorded on main after #630; origin/main not re-run separately, no source file changed).
- `npm run build` exit 0 (UI_V2_ENABLED=1, dummy WC id). Lint: 93 warnings, 0 errors (= baseline 93, delta 0).
- `git diff --stat origin/main`: audit-allowlist.json 14 (+7/−7), package-lock.json 6 (+3/−3), package.json 2 (+1/−1), plus this file.
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/audit-gate-follow-redirects?expand=1

## Findings / follow-ups
- Premise correction: follow-redirects already had an exact pin `1.16.1`, itself inside the vulnerable range. Same rule outcome (allowlist). **Owner action after 2026-11-01T21:32Z:** bump the pin to `1.16.2` and delete the allowlist entry.
- `audit-gate.mjs` ignores `expires` (reads only `ageInOn`, absent everywhere): expiry is not enforced and the stale nudge never fires; the printed "ages in undefined" is the same gap. Not changed here.
