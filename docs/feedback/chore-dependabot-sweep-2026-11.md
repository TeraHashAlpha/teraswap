# chore/dependabot-sweep-2026-11 — feedback

Goal: triage 9 open Dependabot alerts on main. Rule: patched release older than
`.npmrc min-release-age=7` (as of 2026-11-06) → `overrides`; else dated allowlist entry with `expires`.
No `npm audit fix`, no hand-edited lockfile, no Dependabot PR touched, no alert dismissed.

## Commit 1 — facts (2026-11-06)

Dependabot data: `gh api repos/TeraHashAlpha/teraswap/dependabot/alerts`. Ages vs. 2026-11-06.

| Alert | Sev | Package · range · where | Installed now · dependents | Patched (advisory) · release date · age | Dev/prod | Action (by rule) |
|---|---|---|---|---|---|---|
| #142 | Critical | capacitor-swift-pm `>=8.0.0 <=8.3.4` · `ios/App/.../Package.resolved` (Swift, not npm) | 8.2.0 pinned · ios shell | none | runtime (iOS app) | **report only** — not npm, not seen by audit gate |
| #116 | High | tmp `>=0.2.6 <0.2.7` · `contracts/order-engine` lock | 0.2.6 (keeper override) · solc@0.8.28 | 0.2.7 · 2026-05-27 · 163 d | dev | **override `tmp` 0.2.7** (keeper) |
| #134 | High | zod `<4.6.6` · root lock | 4.6.6 root; 3.22.4 + 3.25.76 under walletconnect/cdp | 4.6.6 · 2026-10-11 · 26 d (3.x: none) | runtime | **keep** allowlisted (expires 2026-11-22), untouched |
| #146 | Mod | minimatch `>=7 <11.0.1` · root | 10.2.5 · glob@13.0.6 (`^10.2.2`), @typescript-eslint/typescript-estree (`^10.2.2`) | 11.0.1 · 2026-10-27 · 10 d — **major only** | dev | **STOP** override (forces major). No same-major patch → allowlist (owner decides) |
| #144 | Mod | glob `>=9 <=14.0.1` · root | 13.0.6 · rimraf@6.1.3 (`^13.0.3`), @sentry/bundler-plugins (`^13.0.6`) | 14.0.2 · 2026-10-27 · 10 d — **major only** (13.0.7 published 2026-11-06, 0 d, not a listed fix) | dev/build | **STOP** override (forces major). No same-major patch → allowlist |
| #33 | Mod | uuid `<11.1.1` · root | 9.0.1 (@metamask/utils), 8.3.2 (@metamask/sdk), 7.0.3 (xcode) | 11.1.1 · 2026-04-29 · 191 d — **major only**; advisory lists no 8.x/9.x fix | runtime (wallet connectors) | **STOP** override (forces major). No same-major patch → allowlist |
| #123 | Mod | hono `>=4.12.4 <4.13.11` · root | 4.13.7 (root override — itself vulnerable) · porto@0.2.35 (`^4.x`) | 4.13.11 · 2026-09-29 · 38 d (same major) | runtime | **override `hono` 4.13.11** |
| #3 | Low | elliptic `<=6.6.1` · `contracts/order-engine` lock | 6.6.1 · @ethersproject/signing-key ← hardhat-verify (dev) | none | dev | **allowlist** (expires 2026-12-06) |
| #139 | Low | deepmerge `>=4.2.0 <=4.3.1` · root lock | 4.3.1 · @vanilla-extract/css ← @rainbow-me/rainbowkit | none (4.3.1 is latest) | runtime (wallet UI CSS) | **allowlist** (expires 2026-12-06) |

Judgment: the rule says STOP on an override that forces a major. I read that as "do not apply that override";
the item then falls to the rule's no-patch branch (allowlist). The owner can still choose the major upgrade.

### ios/ answer (#142)
- What it is: Capacitor native iOS shell (`ios/App/App.xcodeproj`, `CapApp-SPM`, `debug.xcconfig`); `capacitor.config.ts` at root; `@capacitor/ios` 8.5.3 in package.json.
- Built/shipped: **no workflow builds it** (grep of `.github/` for `xcodebuild|cap sync|cap copy|capacitor|ios/` → no match). Only manual `cap:*:ios` npm scripts exist. Shipping status is not visible from the repo — owner to confirm.
- Last commit touching it: `a382a5a`, 2026-10-31 (merge of Dependabot PR #599).
- Pin: `Package.resolved` holds `capacitor-swift-pm` 8.2.0 — no patched release, so the alert cannot be cleared by npm. Owner decides whether the folder stays.

### Findings beyond the alert list
- Keeper `npm ci` in `contracts/order-engine` **fails with ERESOLVE** (hardhat-toolbox ↔ chai peer) because root `.npmrc` `legacy-peer-deps=true` does not reach the subdirectory and the keeper has no `.npmrc`. Worked around with `npm ci --legacy-peer-deps --ignore-scripts`; not changed in config.
- CI keeper tests run from `contracts/order-engine/executor/` (its own lock), not from the root keeper lock that Dependabot alerts #116/#3 point at.
- `npm audit` for keeper reports hardhat-verify `invalid` peer under legacy-peer-deps — pre-existing.
- Root `.npmrc` `min-release-age=7` and `audit-gate-lib.mjs` expiry enforcement confirmed present (premise holds).

## Commit 2 — apply (see below)
(filled in next commit)
