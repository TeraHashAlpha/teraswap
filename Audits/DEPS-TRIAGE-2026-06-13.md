# DEPS-TRIAGE — 2026-06-13 (CHORE-HYGIENE-1 Item B)

**Scope:** the 5 currently-open Dependabot PRs (re-triage of the batch held in
`Audits/DEPS-TRIAGE-2026-06-12.md` — a month on, fresh eyes).
**Method:** per-PR diff inspection (GitHub `files` API), registry metadata (`npm view`), upstream
changelogs/GHSA, the live dependency tree (`npm ls`). Base: `origin/main` @ `1b740a8` (post-#179 —
gitleaks rule, H2 fail-closed, tsparticles removed).
**Outcome:** **app safe-batch is EMPTY this round.** One PR (#174 undici) is a **security patch** but
lives in the isolated `contracts/order-engine` workspace — prioritise it there, separately.

---

## Single-instance invariant — baseline (`npm ls @walletconnect/core qr viem @coinbase/wallet-sdk`)

| Dependency | Instances | Version | Notes |
|---|---|---|---|
| `@walletconnect/core` | **1** | 2.21.1 | via package.json override |
| `qr` | **1** | 0.5.5 | via override (the 9Z/INC-2026-06-09-001 crash pin) |
| `viem` (top-level, app) | **1 deduped** | 2.47.4 | all app consumers dedupe |
| `viem` (nested, pre-existing) | 1 | 2.23.2 | `@walletconnect/utils@2.21.1` pins `viem@2.23.2` exact — pre-existing on main, NOT introduced by any of these PRs |
| `@coinbase/wallet-sdk` | **1** | 4.3.6 | |

This baseline is the acceptance gate for any safe-batch candidate. It is **untouched** this round
(only #148 would move app viem, and it is held).

---

## Triage table

| PR | Bump (from→to) | Class | Blast radius | Transitive notes | Recommendation |
|---|---|---|---|---|---|
| **#120** | `@capacitor/core` 8.2.0 → 8.3.4 | minor | **mobile** (native build; `ios/App` exists) | lock diff touches only `@capacitor/core`; deps = `tslib` only (MIT). No WC/qr/viem/coinbase dup, no copyleft. | **verify-isolated** (mobile) — do NOT merge alone (see capacitor note) |
| **#123** | `@capacitor/cli` 8.2.0 → 8.3.4 | minor (devDep CLI) | **mobile** build tooling | only `@capacitor/cli`; standard CLI deps, all MIT, no crypto/wallet deps | **verify-isolated**, paired with #120 |
| **#148** | `viem` (app) 2.47.4 → 2.52.2 | minor, **core-runtime** | quotes / swaps / wallet — everything | viem 2.47.4→2.52.2 + ox 0.14.5→0.14.29 + ws 8.20.0→8.20.1 (collapses a nested ws); all MIT, **no new packages, no copyleft**. BUT wagmi@2.19.5 peer-couples viem (ADR-008). Branch name stale (`viem-2.52.0`); Dependabot rebased to 2.52.2. | **HOLD** — couple with the deferred wagmi-v3 sprint (ADR-008). Do NOT bump alone (P184 skew lesson). |
| **#174** | `undici` 6.23.0 → 6.26.0 (`/contracts/order-engine`) | minor | **isolated-contracts** dev-tooling (`dev:true`, MIT) | single lockfile line; no manifest change, no new packages. **SECURITY — see verdict.** | **PRIORITISE (security), SEPARATE from the app batch** — contracts workspace, independent lockfile |
| **#175** | `ws`+`viem` (`/contracts/order-engine`): viem 2.47.10→2.52.2, ox 0.14.7→0.14.29, ws 8.19.0→8.20.1 | minor | **isolated-contracts** dev-tooling | `@adraffy/ens-normalize@1.11.1` in the diff is a **hoist** (nested-under-ox → top-level), net-zero new package (already 3 refs in the lock). All MIT. **Contracts workspace has ZERO wagmi** → ADR-008 viem-coupling does NOT bind here. | **verify-isolated / separate** — independent workspace; merge when hardhat tooling is next exercised |

---

## undici #174 — SECURITY VERDICT: **yes, a security patch. Prioritise it.**

undici **6.23.0 is vulnerable**; the fixes landed in **6.24.0**, which 6.26.0 includes. Three GHSA
advisories (all "Patched versions: 6.24.0"):

- **CVE-2026-1525 / GHSA-2mjp-6q6p-2qxm** — HTTP request/response **smuggling** via duplicate
  case-variant `Content-Length` headers. Affected `< 6.24.0`.
- **CVE-2026-1528 / GHSA-f269-vfmq-vjvj** — WebSocket 64-bit length overflow → fatal `TypeError`
  crash (**DoS**) from a malicious server frame. Affected `>= 6.0.0 < 6.24.0`.
- **CVE-2026-1527 / GHSA-4992-7rv2-5pvq** — **CRLF injection** via the `upgrade` option. Affected `< 6.24.0`.

(The 6.x DeduplicationHandler DoS CVE-2026-2581 is 7.x-only — not applicable.)

**Exposure:** undici here is a **dev-tooling transitive in `contracts/order-engine`** (`"dev": true`;
the workspace isn't installed in CI by default, and the real contract gate is Foundry `forge test`,
which doesn't read npm) — NOT on any user request path. That lowers real-world exposure, but a
Moderate smuggling/DoS/CRLF triad is still worth clearing, and the patch is a clean one-line,
zero-new-package, MIT bump. **Disposition: owner merges Dependabot #174 promptly into the contracts
workspace.** It does not touch the app lockfile, the single-instance invariant, or the Foundry gate.

---

## Capacitor — re-confirmed TRIO/QUAD (worse than the prior triage)

`Audits/DEPS-TRIAGE-2026-06-12.md` flagged #120+#123 as a trio needing `@capacitor/ios@8.3.4` (no
Dependabot PR for ios). **Re-confirmed today**, and the family is now split THREE ways in the manifest:
`@capacitor/android = 8.3.4` (already moved) but `core / cli / ios = 8.2.0`. Merging #120+#123 brings
core+cli to 8.3.4 but **leaves `ios@8.2.0` skewed** — `npx cap sync ios` warned
`@capacitor/core@8.3.4 doesn't match @capacitor/ios@8.2.0` last round, and `ios` is the native runtime
that ships. **Do NOT merge #120/#123 alone.** Bump `core + cli + ios` (android already aligned)
together on a mobile-release PR + re-sync the stale `ios/App/CapApp-SPM/Package.swift`. Web `next build`
verified green under core@8.3.4 last round.

---

## SAFE BATCH for the app — **EMPTY this round**

No app-side patch/minor that is non-core, non-mobile, and singleton-preserving. Every one of the 5 is excluded:

- **#148 (app viem)** — core-runtime + wagmi-coupled → HOLD (ADR-008).
- **#120 / #123 (capacitor)** — mobile native build, and incomplete without the ios bump → verify-isolated as a trio.
- **#174 (undici)** — `contracts/order-engine` dev-tooling, separate lockfile; security-prioritised but stays out of the app batch.
- **#175 (contracts viem/ws)** — same isolated workspace; no wagmi, independent of #148, but not an app change.

`chore/deps-safe-batch-3` therefore carries **only this triage doc + the FEEDBACK note** — there is no
app dependency change to apply this round. This is the correct, conservative outcome, not a gap.

## Per-PR disposition (for the owner)
1. **#174 undici → merge promptly** (security: CVE-2026-1525/1527/1528, fixed in 6.24.0). Contracts workspace; verify `forge test` unaffected (it is — forge doesn't read npm).
2. **#175 contracts viem/ws → verify-isolated, separate.** No wagmi coupling; merge when hardhat tooling is next touched (could ride with #174 — same workspace).
3. **#148 app viem → HOLD** for the wagmi-v3 sprint (ADR-008). Never bump alone.
4. **#120/#123 capacitor → HOLD; re-issue as a `core+cli+ios` trio** (android already aligned) on a mobile-release cycle with an `ios/` re-sync. Do not merge the two alone.
5. **App safe-batch: empty** — nothing safely mergeable into the app runtime this round.
