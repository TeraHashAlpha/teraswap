# DEPS-TRIAGE — 2026-06-12 (CHORE-DEPS-2)

**Scope:** the 11 open Dependabot PRs (some held from 9I).
**Method:** per-PR diff inspection via API (no guessing), registry metadata for transitive trees,
upstream release notes for majors, local full-gate verification of the safe batch on
`chore/deps-safe-batch-2` (off `origin/main` @ `0384212`, post-#169).
**History informing this triage:** qr@0.6.0 crash (hotfix → pin 0.5.5), ua-parser-js AGPL transitive,
P184 duplicate @walletconnect/core.

---

## Critical single-instance invariant (verified before AND after the safe batch)

| Dependency | Instances | Version | Notes |
|---|---|---|---|
| `@walletconnect/core` | **1** | 2.21.1 | via package.json override (9K/9Z) |
| `qr` | **1** | 0.5.5 | via override — the 9Z crash pin; **must not move** |
| `viem` (top-level) | **1 deduped** | 2.47.4 | all app consumers dedupe to it |
| `viem` (nested, pre-existing) | 1 | 2.23.2 | **pre-existing on main**, NOT introduced by any of these PRs — `@walletconnect/utils@2.21.1` pins `viem@"2.23.2"` *exact* inside `@wagmi/connectors/node_modules/@walletconnect/ethereum-provider`. Unfixable without overriding WC internals; unchanged by the batch. Documented in FEEDBACK. |
| `@coinbase/wallet-sdk` | **1** | 4.3.6 | |

---

## Triage table

| PR | Bump | Class | Blast radius | Transitive notes | Disposition |
|---|---|---|---|---|---|
| **#147** | vitest 4.1.7 → 4.1.8 (dev-deps group; sole member) | patch (devDep) | test tooling only | 8 lockfile entries (vitest cluster), **0 new packages**, MIT | **SAFE-BATCH — applied** ✅ |
| **#142** | hono 4.12.18 → 4.12.23 (lockfile-only) | patch, in-range (`^4.10.3`) | nested runtime: `wagmi → @wagmi/connectors → porto → hono` | `npm update hono` landed **exactly 4.12.23**; 0 deps, MIT, 0 new packages | **SAFE-BATCH — applied** ✅ |
| **#163** | codeql-action 3.28.10 → 4.36.2 | major (CI-only) | codeql.yml | Held 9I decision applied: pin **annotated-tag commit SHA** `7211b7c8077ea37d8641b6271f6a365a22a5fbfa` (# v4.x) — verified upstream = `v4.36.0` tag target (not the tag object). Supersedes the PR's 4.36.2 floating ref. | **APPLIED (held decision)** ✅ — owner closes #163 after merging this branch |
| **#135** | gitleaks-action 2.3.9 → 3.0.0 | **major** (CI-only) | gitleaks.yml only | Upstream v3.0.0 notes: *"No changes to inputs, outputs, or behavior"* — pure node20→node24 runtime migration. **Deadline-driven:** GitHub flipped the runner default to node24 on **2026-06-02** (already past); node20 removed entirely **2026-09-16**. Our job invokes it with GITHUB_TOKEN only (no license input, no custom args) → nothing to migrate. | **verify-isolated → merge promptly.** Re-pin to commit SHA `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e` (# v3.0.0; lightweight tag). Not bundled here per the Do-NOT (major). |
| **#136** | actions/checkout 4.2.2 → 6.0.3 (4 workflows) | **major** (CI-only) | all workflows | v5+ = node24, min runner 2.327.1 (hosted runners OK). v6 change: credentials persisted to a **separate file** instead of .git/config — none of our jobs push/re-auth in-job → low impact. **Repo currently has MIXED pins:** v4.2.2 (codeql.yml, gitleaks.yml) + v5 (ci.yml ×6, security-audit.yml). v4.2.2 is node20 → hits the same 2026-09-16 removal. | **verify-isolated:** one follow-up PR aligning ALL workflows to `df4cb1c069e1874edd31b4311f1884172cec0e10` (# v6.0.3, annotated-tag target). Don't take Dependabot's floating bump. |
| **#148** | viem 2.47.4 → 2.52.0 (app) | minor, **core runtime** | quotes/swaps/wallet — everything | wagmi 2.19.5 peer-couples viem (ADR-008); the nested WC `viem@2.23.2` is unaffected either way. Bumping viem alone risks wagmi/connector skew (P184 lesson class). | **HOLD** — couple with the deferred wagmi-v3 sprint (ADR-008). Do NOT bump alone. |
| **#120** | @capacitor/core 8.2.0 → 8.3.4 | minor | mobile runtime (`ios/App` exists) | deps = `tslib` only → cannot introduce WC/qr/viem/coinbase dups; MIT | **verify-isolated (§4)** — local verification on this machine: see "Capacitor isolated verification" below. Pair with #123; note iOS re-build needed on release. |
| **#123** | @capacitor/cli 8.2.0 → 8.3.4 | minor (devDep CLI) | mobile build tooling | standard CLI deps (tar/commander/fs-extra/…), all MIT-family, no copyleft, no crypto/wallet deps | **verify-isolated (§4)** — pair with #120 |
| **#92** | serialize-javascript + hardhat-toolbox 6.1.2→**7.0.0** (/contracts/order-engine) | major (toolbox) | isolated contracts **dev-tooling** | **Conflicts with #94** (same hardhat-toolbox bump — merging one forces a rebase of the other). The real contract gate is Foundry (`forge test`), which does not read npm deps — verified green locally (68/68 + 19/19). | **HOLD / separate (§5)** — prefer #94 (superset), let #92 rebase or close |
| **#94** | ws + viem(contracts) 2.47.10→2.51.0 + hardhat-toolbox 6.1.2→**7.0.0** (/contracts/order-engine) | major (toolbox) | isolated contracts dev-tooling | contracts-workspace viem is independent of the app's viem (no wagmi coupling there — ADR-008 does not bind it). hardhat-toolbox 7 is a peer-deps reshuffle; only affects hardhat scripts, not forge. | **HOLD / separate (§5)** — owner merges when hardhat tooling is next exercised; forge gate unaffected (verified) |
| **#161** | axios 1.14.0 → 1.17.0 (/contracts/order-engine, lockfile-only) | minor | isolated contracts dev-tooling | hardhat transitive | **HOLD / separate (§5)** — same bucket as #92/#94 |

---

## Safe batch — verification evidence (this branch)

Applied: **vitest 4.1.8** (package.json + lock) + **hono 4.12.23** (lockfile-only, in-range) +
**codeql-action v4 SHA pin** (held decision).

Lockfile delta: only the vitest cluster (8 entries) + hono version/integrity — **zero packages
added or removed → zero new licenses to vet** (no AGPL/GPL exposure possible).

| Gate | Pre-#169 base (28714ab) | Final base (0384212) |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| `npm run lint` | 0 errors | 0 errors |
| `vitest run` | 1656/1656 | 1671/1671 |
| `next build` | OK | OK |
| `forge test` (order-engine) | 68/68 | 68/68 |
| `forge test` (FeeCollector) | 19/19 | 19/19 |
| Singleton invariant | holds | holds |

## Capacitor isolated verification (#120 + #123, NOT in the batch)

Bumped both to 8.3.4 in an isolated working state (this machine, darwin); state fully reverted
afterwards (`git checkout package.json package-lock.json && npm ci` + ios/ artifact), singleton
invariant re-checked before and after.

- **`next build`** ✅ — clean under @capacitor/core 8.3.4.
- **`npx cap sync ios`** ✅ — sync finished; 3 plugins detected (@capacitor/browser 8.0.3,
  splash-screen 8.0.1, status-bar 8.0.2).
- **Finding 1 — the pair is actually a TRIO:** sync warns
  `@capacitor/core@8.3.4 version doesn't match @capacitor/ios@8.2.0`. There is **no Dependabot PR
  for @capacitor/ios** — merging #120+#123 alone leaves core/ios skewed. Bump all three together
  (`@capacitor/core@8.3.4 + @capacitor/cli@8.3.4 + @capacitor/ios@8.3.4`).
- **Finding 2 — committed iOS project is stale:** the sync rewrote `ios/App/CapApp-SPM/Package.swift`
  (pins capacitor-swift-pm `exact` + adds the 3 plugin SPM package entries) — i.e. the committed
  file predates the current plugin set even at 8.2.0. A `cap sync` + commit of ios/ is due at the
  next mobile release regardless of this bump. (Experiment's rewrite was reverted, not committed.)
- **Verdict: green-and-safe** for web build; **needs-follow-up** for the trio bump + an iOS
  rebuild/test on a release cycle (do not merge #120/#123 alone).

## Per-PR disposition summary (for the owner)

- **Merge this branch** (`chore/deps-safe-batch-2`) → then close #147, #142, #163 (superseded).
- **#135** gitleaks-action v3: merge promptly via SHA re-pin `e0c47f4f8be3…` (# v3.0.0) — deadline-driven (node20 removal 2026-09-16; default already flipped 2026-06-02).
- **#136** checkout: replace with ONE follow-up PR pinning all 4 workflows to `df4cb1c069e1…` (# v6.0.3).
- **#148** viem: HOLD for the wagmi-v3 sprint (ADR-008).
- **#120/#123** capacitor 8.3.4: do NOT merge alone — bump as a TRIO with `@capacitor/ios@8.3.4` (no Dependabot PR exists for it); web build verified green; iOS rebuild + stale `Package.swift` re-sync due at next mobile release.
- **#92/#94/#161** contracts dev-tooling: HOLD/separate; #94 supersedes #92's toolbox bump; forge gate independent (verified).
