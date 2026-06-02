# Dependabot Triage — SPRINT-9I (2026-06-02)

**Author:** Code Agent (Claude Code)
**Branch (safe batch):** `chore/deps-safe-batch` (off `origin/main` @ `4aa5aff`, PR #127 merged)
**Scope:** triage + local verification of the 10 open Dependabot PRs. The Code Agent
cannot merge GitHub PRs — this produces a verified triage and a branch with the SAFE
bumps applied for the owner to PR/merge. None of these block the live Base arc.

---

## Methodology & tooling notes

- **Semver class** = patch / minor / major of the bump. **Blast radius** = core app runtime
  vs CI-only vs isolated `/contracts/order-engine` dev-tooling.
- **Security signal:** the Sonatype MCP (`sonatype-guide`) was **unauthenticated in this
  environment** ("Authentication required") — all three tools failed. Per the skill's
  fallback guidance, security was assessed with `npm audit` (GitHub Advisory DB, reflects the
  real installed tree) + registry metadata + changelog review. See FEEDBACK.
- **PR enumeration:** the `gh` CLI on this host is the npm `node-gh` package (not GitHub CLI)
  and is non-functional/unauthenticated, so the PR list is taken from the SPRINT-9I prompt
  (authoritative as of 2026-06-02). Versions/SHAs were verified against the npm registry and
  `git ls-remote`.
- **Supply-chain guard:** root `.npmrc` enforces `min-release-age=7` (no package < 7 days old),
  `save-exact=true`, `ignore-scripts=true`, `legacy-peer-deps=true`. All bump targets clear the
  7-day cooldown (latest is viem@2.51.0, published 2026-05-25).
- **Baseline (origin/main, pre-bump):** tsc 0 errors · eslint 0 errors (110 pre-existing
  warnings) · **1399/1399 tests (100 files)** · `next build` OK · `forge build` OK.

---

## Triage table

| PR | Package | Bump | Class | Blast radius | Risk | Recommendation |
|----|---------|------|-------|--------------|------|----------------|
| #122 | `@capacitor/browser` | 8.0.2 → 8.0.3 | patch | app (in-app browser) | Low | **SAFE-BATCH ✅ applied** |
| #121 | `@upstash/redis` | 1.37.0 → 1.38.0 | minor | app (rate-limit/KV) | Low | **SAFE-BATCH ✅ applied** |
| #100 | `gitleaks-action` | v2.3.6 → v2.3.9 | patch (CI) | CI-only (secret scan) | Low | **SAFE-BATCH ✅ applied** |
| #124 | `viem` | 2.47.4 → 2.51.0 | minor | **app core** (encoding/clients/adapters/wagmi) | Med | **VERIFY-ISOLATED → PASS;** hold to ride with wagmi v3 (ADR-008) |
| #120 | `@capacitor/core` | 8.2.0 → 8.3.4 | minor | app (mobile runtime) | Med | **VERIFY-ISOLATED → PASS w/ follow-up** (bump `@capacitor/ios` too) |
| #123 | `@capacitor/cli` | 8.2.0 → 8.3.4 | minor | mobile build tooling | Med | **VERIFY-ISOLATED → PASS w/ follow-up** (pair with #120 + ios) |
| #99 | `codeql-action` | v3.28.10 → v4.36.0 | **major** (CI) | CI-only (SAST) | Med | **VERIFY-ISOLATED → PASS (drop-in);** owner merges, confirm on first CI run |
| #94 | `ws` + `viem` + `hardhat-toolbox` | (grouped) | mixed | `/contracts/order-engine` dev-tooling | Low-app | **HOLD** — see order-engine note |
| #93 | `axios` | 1.14.0 → 1.16.1 | minor | `/contracts/order-engine` dev-tooling | Low-app | **HOLD** — see order-engine note |
| #92 | `serialize-javascript` + `hardhat-toolbox` | (grouped) | mixed | `/contracts/order-engine` dev-tooling | Low-app | **HOLD** — see order-engine note |

> **Deviation from the prompt:** the SPRINT-9I prompt grouped the `/contracts/order-engine`
> bumps (#92/#93/#94) into the safe batch. They were **moved to HOLD** after a clean install
> there `ERESOLVE`d on a pre-existing hardhat v2/v3 peer conflict (evidence below). The prompt's
> own rule — *"only keep bumps that stay 100% green"* — takes precedence over the inclusion.

---

## SAFE BATCH — applied & verified (commit `9af1236`, signed)

Three low-risk bumps applied together on `chore/deps-safe-batch`:

- `@capacitor/browser` 8.0.2 → **8.0.3** (patch; #122)
- `@upstash/redis` 1.37.0 → **1.38.0** (minor; #121) — deps unchanged (`uncrypto ^0.1.3`)
- `gitleaks-action` → **v2.3.9** SHA `ff98106e4c7b2bc287b24eaf42907196329070c7` (#100)

**Verification (with all three applied):** tsc **0 errors** · eslint **0 errors** ·
**1399/1399 tests** · `next build` **OK (✓ Compiled successfully)**. Identical to baseline.

**Lockfile handling (important for CI):** a plain `npm install` / `npm install --package-lock-only`
on this darwin-arm64 host **prunes the cross-platform `@next/swc-*@16.2.6` optionals**
(linux-x64-gnu/musl, win32, darwin-x64) down to the local platform. Because CI/Vercel run
`npm ci` on **Linux**, that would drop the required `@next/swc-linux-x64-gnu` binary. The lock
was therefore **patched surgically** (only `version`/`resolved`/`integrity` for the two packages
+ the two root specifiers) so all six platform entries are preserved. Validated with
`npm ci --dry-run` (exit 0, lock ⇄ package.json in sync).

**Security note (gitleaks):** the workflow previously pinned `44c470ff… # v2.3.7`, but that SHA
actually resolves to tag **v2.3.6** — the version comment was inaccurate. The bump corrects both
the SHA (→ v2.3.9) and the comment. (SHA-pinning is the correct defense; the commit SHA is
immutable regardless of tag moves.)

---

## SENSITIVE — verified in isolation (NOT batched)

Each tested alone on a throwaway working tree, then reverted. Never combined with the safe batch
or with each other.

### #124 — viem 2.47.4 → 2.51.0 — **PASS (green), but hold for wagmi v3**
- tsc **0 errors** (viem types pervade the codebase — the #1 breakage vector for a viem bump).
- **1399/1399 tests** (adapters, chain config, swap, encoding) · `next build` **OK**.
- **Live quote smoke (dev server, real external APIs):**
  - Mainnet WETH→USDC (chainId 1): **HTTP 200**, best `kyberswap` ~1940.04 USDC, 4+ sources.
  - Base WETH→USDC (chainId 8453): **HTTP 200**, best `cowswap` ~1882.58 USDC, 4+ sources.
- **Recommendation:** viem 2.51 is safe on its own, **but do not merge standalone.** Per ADR-008
  and the SPRINT-9I prompt, it should ride **with** the wagmi v3 migration so wagmi↔viem peer
  alignment is handled in one change. See `Audits/WAGMI-V3-SCOPING-2026-06-02.md`.

### #120 + #123 — @capacitor/core + @capacitor/cli 8.2.0 → 8.3.4 — **PASS w/ follow-up**
- tsc **0 errors** · `next build` **OK** · `npx cap sync ios` **exit 0** (modern Capacitor uses
  Swift Package Manager — no CocoaPods needed; `Package.swift` written, web assets copied,
  plugins updated incl. `@capacitor/browser@8.0.3`).
- **Follow-up:** cap sync warns `@capacitor/core@8.3.4` ≠ `@capacitor/ios@8.2.0`. For a clean 8.3
  bump, **also bump `@capacitor/ios` 8.2.0 → 8.3.4** in the same PR (`@capacitor/android` is
  already 8.3.4; `splash-screen`/`status-bar`/`browser` are on their own 8.0.x lines, which is
  normal). A full **iOS/Xcode native build was not runnable here** (no Xcode/CocoaPods) — that is
  the owner's final gate.

### #99 — codeql-action v3.28.10 → v4.36.0 — **PASS (drop-in, CI-only)**
- Cannot run GitHub Actions locally; assessed via workflow structure + official changelog.
- v4 is a major **runtime** refresh: *"[v4+ only] The CodeQL Action now runs on Node.js v24"* and
  *"minimum required CodeQL bundle version 2.19.4"* (auto-downloaded). **No changes** to the
  `languages` / `queries: security-extended` / `category` inputs or the init/autobuild/analyze
  steps this workflow uses. `runs-on: ubuntu-latest` (GitHub-hosted) supports node24 actions.
- **Pin to the dereferenced COMMIT SHA `7211b7c8077ea37d8641b6271f6a365a22a5fbfa`** for all three
  steps (NOT the annotated-tag object `f52b05f4…`). v3 is being deprecated, so this is needed, not
  optional. Final confirmation = the first CI run on the PR. (v4.36.1 is also available.)

---

## `/contracts/order-engine` bumps (#92 / #93 / #94) — **HOLD**

**Blocker (evidence):** a clean install in `contracts/order-engine` fails:

```
npm error ERESOLVE unable to resolve dependency tree
Found: hardhat@3.1.10
Could not resolve dependency:
peer hardhat@"^2.28.0" from @nomicfoundation/hardhat-ethers@3.1.3
  peer @nomicfoundation/hardhat-ethers@"^3.1.3" from @nomicfoundation/hardhat-toolbox@6.1.2
```

The package already has a **pre-existing hardhat v2 / v3 peer conflict** (`hardhat-toolbox@6.1.2`
is built for hardhat v2; the project runs hardhat v3). There is no local `.npmrc`, so it does not
inherit the root `legacy-peer-deps=true`. Any `npm install` / `npm audit fix` / `npm update` there
needs `--legacy-peer-deps` or `--force`, i.e. accepting an *already-broken* tree — which does not
meet the "100% green" bar for the safe batch. The real remediation is the **`hardhat-toolbox`
v6 → v7 major** (which adds hardhat v3 support and pulls the patched transitives).

**Impact is low:** the contracts compile and test via **Foundry** (`forge build` → exit 0, 672
files, Solc 0.8.28), which does **not** use these npm dev-deps. `npm audit` here reports 32
findings (5 high / 17 mod / 10 low) under `ethers→ws`, `viem→ws`, `serialize-javascript`, and the
hardhat toolchain — all **dev-tooling, no app-runtime exposure**.

**Recommendation:** address #92/#93/#94 together via a dedicated `hardhat-toolbox` v7 migration
(verify-isolated), or via targeted `overrides` installed with `--legacy-peer-deps`. Do **not**
fold into the safe batch.

---

## wagmi v3 linkage (the 22 moderate npm-audit alerts)

Root `npm audit` = **22 moderate**, **all** transitive under
`@wagmi/connectors → @reown/appkit-*` (appkit-pay / scaffold-ui / ui / utils / controllers and
`@walletconnect/universal-provider`). **None** touch `@capacitor/*`, `@upstash/redis`, or `viem`
directly — confirming the safe batch and the viem bump are orthogonal to them. These close only
with the **wagmi v3 major**. Scoped (not implemented) in `Audits/WAGMI-V3-SCOPING-2026-06-02.md`
and ADR-008.

---

## Owner action items

1. **Merge `chore/deps-safe-batch`** (#122 + #121 + #100) — verified green, signed.
2. Open a small PR for **#120 + #123 + `@capacitor/ios` 8.3.4**; run an iOS/Xcode build to confirm.
3. Merge **#99 (codeql v4)** using commit SHA `7211b7c8…`; confirm the first CodeQL CI run.
4. **Defer #124 (viem 2.51)** into the wagmi v3 sprint (ADR-008) — do not merge standalone.
5. Schedule the **`hardhat-toolbox` v7** effort for #92/#93/#94 (isolated dev-tooling).
