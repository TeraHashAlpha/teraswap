# Feedback — DEPS-BATCH-7

## Advisory table (full tree, `npm audit` with `node_modules` installed — see Concern below)

| Package | Sev | Vulnerable range | Patched | Class |
|---|---|---|---|---|
| @babel/core | low | <=7.29.0 | 7.29.6 (7.x, direct) | **Fixed this batch** |
| hono / porto | moderate | 4.0.0–4.12.26 | 4.12.27 (via wagmi major) | **Fixed this batch** |
| tar | moderate | <=7.5.20 | 7.5.21/7.5.22 | **Skipped — <7d old** |
| brace-expansion / minimatch / eslint / @eslint/* | high | various | eslint@10.8.0 (major) | Deferred (explicit) |
| uuid / wagmi / @wagmi/connectors / @metamask/* / @gemini-wallet/core | moderate | various | wagmi@3.7.4 (major) | Deferred (explicit, uuid named) |
| eslint-config-next / eslint-plugin-* | high | various | eslint-config-next@1.x (major) | Not in scope |
| @typescript-eslint/* / typescript-eslint | high | various | direct (needs version bump, not override-safe alone) | Not in scope |
| @sentry/nextjs / @sentry/bundler-plugin-core / glob | high | various | @sentry/nextjs@10.9.0 (major, and *older* than current 10.59.0 pin — do not apply) | Not in scope |
| @capacitor/cli | moderate | wide range | direct | Not in scope |

0 `@walletconnect/*` advisories present — those overrides are already clean.

## Fixed this batch
- `hono`: 4.12.25 → **4.12.27** (override bump; released 2026-06-23, well past 7-day floor)
- `@babel/core`: **7.29.6** (new override; released 2026-05-25, well past 7-day floor)

## Skipped by 7-day gate
- `tar`: stays pinned at 7.5.20 (still vulnerable). Only two patched versions exist, 7.5.21
  (2026-07-21, 6 days old) and 7.5.22 (2026-07-24, 3 days old) — both younger than the 7-day
  floor as of 2026-07-27. Neither qualifies; re-check after 2026-07-28.

## Deliberately deferred (unchanged, per goal)
- `brace-expansion`, `uuid` — both require a semver-major bump upstream (`eslint@10`,
  `wagmi@3`), left untouched as instructed.

## Concern — audit baseline discrepancy
The goal's stated baseline (9 high / 10 moderate) doesn't match what `npm audit` reports with
a real `node_modules` installed: **19 high / 12 moderate / 1 low (32 total)** before this
batch, dropping to **19 high / 10 moderate / 0 low (29 total)** after. The extra ~11 findings
(`@sentry/*`, `@typescript-eslint/*`, `@capacitor/cli`, `glob`, `eslint-config-next`,
`eslint-plugin-*`) only surface when `npm audit` runs against an installed tree, not a bare
lockfile — worth checking whether the weekly audit report generation needs `npm install`
before `npm audit` to avoid under-reporting. Also note: `@sentry/nextjs`'s suggested fix
(10.9.0) is *older* than the current pin (10.59.0) — npm's fixAvailable picked a stale
version; do not apply it blindly if picked up in a future batch.

## npm audit before/after (this batch only)
- Before: 1 low / 12 moderate / 19 high (32 total)
- After: 0 low / 10 moderate / 19 high (29 total)
- Cleared: `@babel/core` (low), `hono` + `porto` (moderate, both via hono)
