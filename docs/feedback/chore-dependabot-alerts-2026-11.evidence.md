# chore/dependabot-alerts-2026-11 — evidence (companion to chore-dependabot-alerts-2026-11.md)
Measured 2026-11-14 at origin/main 130f2ddf, Node 25.6.1 / npm 11.10.1 on the owner's Mac (CI uses Node 22). Alerts from `gh api repos/TeraHashAlpha/teraswap/dependabot/alerts?state=open` (read-only), paths from `npm ls --all`, advisories from `gh api advisories/GHSA-…`, publish dates from `npm view PKG time`. `.npmrc` `min-release-age=7` was never relaxed.

## A. Alert table (evidence 1)
| # | Sev | Package | Dependency path (vulnerable copy) | Vulnerable → first patched (published, age on 2026-11-14) | Action |
|---|-----|---------|-----------------------------------|------------------------------------------------------------|--------|
| 134 | high | zod | 3.25.76: wagmi → @wagmi/connectors → @base-org/account → @coinbase/cdp-sdk (`zod ^3.25.76`, plus abitype@1.0.6 deduped). 3.22.4: … → @walletconnect/ethereum-provider → @reown/appkit → @reown/appkit-wallet (`zod 3.22.4`, exact; hoisted to `node_modules/@wagmi/connectors/node_modules/zod`). abitype@1.2.3 (viem), porto and eslint-plugin-react-hooks already resolve to the patched 4.6.6. | `<4.6.6` → 4.6.6 (2026-10-11, 34 d). No 3.x release exists past 3.25.76. | NONE (new major for both parents). Stays open. |
| 149 150 152 153 | medium | hono | one copy: wagmi → @wagmi/connectors → porto@0.2.35 (`hono ^4.10.3`), held at 4.13.11 by the exact root override `package.json:95` | `<=4.13.15` → 4.13.16 (2026-11-01, 13 d) | FIXED, commit `4f7b6fb9`: override 4.13.11 → 4.13.16, lockfile by npm, `npm ci` from clean, `npm ls hono` = 4.13.16 only |
| 151 | low | hono | same | same | FIXED, same commit |
| 146 | medium | minimatch | 10.2.5 (overridden pin): @capacitor/cli → rimraf@6 → glob@13; @sentry/nextjs → @sentry/bundler-plugins → glob@13; typescript-eslint → @typescript-eslint/typescript-estree. (3.1.5 copies under eslint are outside the range.) | `>=7.0.0 <11.0.1` → 11.0.1 (2026-10-27, 18 d). No 10.x patch (10.2.6 is still in range). | NONE (major 10 → 11; glob@13 and typescript-estree take `^10.2.2`). Stays open. |
| 144 | medium | glob | 13.0.6: @capacitor/cli → rimraf@6 (`^13.0.3`); @sentry/nextjs → @sentry/bundler-plugins (`^13.0.6`) | `>=9.0.0 <=14.0.1` → 14.0.2 (2026-10-27, 18 d) | NONE (major 13 → 14). Stays open. See note D1 on glob 13.0.7. |
| 33 | medium | uuid | 9.0.1 (@metamask/utils 8/9/11, via @metamask/sdk, @gemini-wallet/core, cbw-sdk), 8.3.2 (@metamask/sdk, sdk-communication-layer), 7.0.3 (xcode ← @capacitor/cli) | `<11.1.1` → 11.1.1 (2026-04-29, 199 d); 12.0.1 and 13.0.1 also patched. No 7.x/8.x/9.x release. | NONE (major for all three copies). Stays open. |
| 139 | low | deepmerge | 4.3.1: @rainbow-me/rainbowkit@2.2.10 → @vanilla-extract/css@1.17.3 | `>=4.2.0 <=4.3.1` → none (4.3.1 is the last release, 2023-03-16) | NONE (no patch exists). Stays open. |
| 3 | low | elliptic | 6.6.1 in `contracts/order-engine/package-lock.json`: hardhat-toolbox → hardhat-verify@3.0.12 → @ethersproject/abi → hash → abstract-signer → abstract-provider → transactions → signing-key (devDependencies) | `<=6.6.1` → none (last release 2024-11-13) | NONE (no patch exists). Stays open. |
| 147 | critical | capacitor-swift-pm (SwiftPM) | `archive/mobile-prototype-2026/ios/App/App.xcodeproj/.../swiftpm/Package.resolved`, pinned 8.2.0 | `>=8.0.0 <=8.3.4` → none listed | NOT TOUCHED (owner). Proof in the main file. |

Counts: 12 open alerts at start. Commit 1 fixes 5 (hono; they close when GitHub re-scans main after the merge). 7 stay open: 6 non-Capacitor (#134 #146 #144 #33 #139 #3) plus #147 (the owner's).

## B. `npm audit` before and after (evidence 2)
Root lockfile, `npm audit --json`, counts are PACKAGES not alerts (a package row can carry several advisories):
| | info | low | moderate | high | critical | total |
|-|-----|-----|----------|------|----------|-------|
| before (origin/main 130f2ddf) | 0 | 3 | 23 | 11 | 0 | 37 |
| after commit 1 (4f7b6fb9) | 0 | 3 | 21 | 11 | 0 | 35 |
Removed rows: `hono`, `porto`. Every other row is unchanged. Remaining 35 = the allowlisted chains (zod via cdp-sdk/appkit-wallet → @wagmi/connectors → wagmi; uuid via @metamask/*; glob/minimatch via @sentry/nextjs, @capacitor/cli, typescript-eslint; deepmerge via rainbowkit) — every `fixAvailable` there is a semver-major (wagmi 3.7.11, @sentry/nextjs 11.12.0, rainbowkit 0.1.0) or a package we may not move.
`contracts/order-engine` lockfile (`npm audit --package-lock-only`): 7 low + 5 high = 12, unchanged by this branch. NOTE: that includes a high `zod` (via `@nomicfoundation/hardhat-zod-utils`) and `hardhat`, yet Dependabot lists only #3 (elliptic) open for that manifest. Not investigated further (dev-only hardhat tooling; the keeper runtime is `contracts/order-engine/executor`, whose lockfile contains none of the seven packages — `npm ls --package-lock-only` prints `(empty)` for all of them).

## C. Reachability measurements (build at 4f7b6fb9, `npm run build` exit 0, 258 browser chunks)
Marker strings were first confirmed to exist in the installed package source (e.g. `invalid_union_discriminator` is in zod 3.25.76 `v3/ZodError.js`; `Namespace must be array-like` is in `uuid/dist/v35.js`), then grepped in `.next/static/**/*.js` (browser) and `.next/server/**/*.js`:
| Package | Marker | Browser chunks | Server files | Traced into any `.nft.json` (68 nft files; control: `node_modules/next/` 68, `/react/` 2, `/@sentry/` 17) |
|---------|--------|---------------|--------------|------|
| zod 3.x | `invalid_union_discriminator`, `invalid_type_error`, `ZodParsedType` | 0 | 0 | 0 |
| zod 4.x | `_zod`, `$ZodError`, `$ZodType`, `too_big` | 0 | 0 | 0 |
| uuid v3/v5 | `Namespace must be array-like`, `Invalid namespace UUID` | 0 | 0 | 0 |
| hono | `RegExpRouter`, `SmartRouter`, `TrieRouter` | 0 | 0 | 0 |
| deepmerge | `isMergeableObject` | 0 | 0 | 0 |
| glob | `GlobWalker`, `GlobStream` | 0 | 0 | 0 |
| minimatch | `GLOBSTAR` | 0 | 0 | 0 |
Other hits that look like matches but are not: `ZodError` appears once in a server chunk, inside Sentry's own `ZodErrors` integration (`f.name==="ZodError"`), not the zod library; `MetaMaskSDK` appears in ONE browser chunk (`.next/static/chunks/3q9ld2jlulcr6.js`, the MetaMask connector) which contains `uuid` three times and none of the v3/v5 markers; `appkit-wallet` appears once as a storage-key string constant (`"@appkit-wallet/SOCIAL_USERNAME"`), not as the package.
First-party imports of the seven packages in `src/`, `scripts/`, `workers/`, `contracts/order-engine/executor`, root configs: 0 (`grep -rnE "from '(uuid|deepmerge|zod|glob|minimatch|hono|rimraf|elliptic)…'"`).
uuid callers inside the dependents: @metamask/utils, @metamask/sdk, @metamask/sdk-communication-layer and xcode import only `v4` and `validate` (grep of their sources: `import { v4 as uuidv4 }` x8, `uuid.v4` x5, `import { validate }` x4, `{ validate as .., v4 as .. }` x2); 0 references to `v3`, `v5` or `v6` in any of them.
zod 3.22.4 has no `handleArrayResult` (the function the advisory names); 3.25.76 has it only under its `v4` subtree, and cdp-sdk imports bare `"zod"` (the v3 API).
deepmerge: rainbowkit's compiled entry imports `@vanilla-extract/dynamic` and `@vanilla-extract/sprinkles/*`, never `@vanilla-extract/css` at runtime.

## D. Notes
D1. **glob 13.0.7** (published 2026-11-06, 8 d, past the 7-day age, inside both consumers' ranges `^13.0.3` / `^13.0.6`). Diffing the tarballs (`npm pack`, scratch dir) shows 13.0.6 → 13.0.7 changes the abort branches of `walker.js` from `cb();` to `return cb();` in four places and drops one `if (this.signal?.aborted) return;`. The advisory's root cause is exactly "abort branches in src/walker.ts call cb() without returning". So 13.0.7 very probably carries the fix, but the advisory lists 14.0.2 as the only patched version and its range `<=14.0.1` still covers 13.0.7, so `npm update glob` would change nothing in `npm audit` or in alert #144. NOT applied; the owner can ask for it as a separate one-package commit. I did not verify the fix by running the reproduction.
D2. **@capacitor/cli 8.6.2** (published 2026-11-12, 2 d) depends on `xcode ^4.0.0`; `npm audit` calls that the non-major fix for the @capacitor/cli → xcode → uuid 7.0.3 chain. It is a direct dev dependency and younger than 7 days, so it is NOT installed; it becomes eligible 2026-11-19 (8.6.1 and 8.6.0 are also minor bumps of the pinned 8.5.3). Not touched: Capacitor is the owner's.
D3. **hono 4.13.17 / 4.13.18** are newer than 4.13.16; I pinned the FIRST patched version (4.13.16, the minimum that closes all five advisories) and did not take later patch releases.
D4. `npm ls zod` prints `invalid: "^3 >=3.22.0" from node_modules/@walletconnect/utils/node_modules/abitype` (zod@4.6.6 deduped under abitype@1.0.8). It is pre-existing and comes from the `zod@^4` override together with an optional peer range; the exit code of `npm ls zod` is non-zero because of it. Not changed.
