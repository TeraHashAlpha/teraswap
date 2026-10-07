# Feedback — chore/order-engine-deps-ws-adm-zip-tmp

Dependabot triage 2026-10-07: three HIGH alerts under `contracts/order-engine`, outside the root audit gate.
`undici` (#536) stays with Dependabot; `elliptic` has no patch (listed, not touched).

## Checklist
- [x] C1 evidence (paths, entry point, publish ages)
- [x] C2 executor: `ws` 8.18.3 → 8.21.0 via `overrides`
- [x] C3 order-engine dev: `adm-zip` 0.4.16 → 0.6.1, `tmp` 0.0.33 → 0.2.6 via `overrides`
- [ ] C4 host checklist (feedback only)

## 1. Dependency paths (origin/main bd64d8a)
- **A `ws`** executor/: `viem@2.47.10 → ws@8.18.3` and `viem → isows@1.0.7 → ws (deduped)`. **prod** (viem is a runtime dep).
  Entry point: `executor/executor.js:89-100` imports `viem`; `executor/event-watcher.js:19` imports `viem`.
  Both load the viem module graph that pulls `ws`; no file imports `ws` directly and the watcher is
  polling-only (`event-watcher.js:12`), so the HTTP transport is the only one in use.
- **B `adm-zip`** order-engine/: `hardhat@3.1.10 → adm-zip@0.4.16`. **dev** (`"dev": true` in lock).
- **C `tmp`** order-engine/: `solc@0.8.28 → tmp@0.0.33`. **dev**.
- Pre-existing, not mine: `npm ls` flags `hardhat@3.1.10 invalid` (toolbox wants `^2.28.0`, hardhat-verify
  wants `^3.1.11`). Left alone — out of scope, no major bumps.

| pkg | version | published | age |
|---|---|---|---|
| ws | 8.21.0 | 2026-05-22 | 137d |
| adm-zip | 0.6.1 | 2026-09-11 | 26d |
| tmp | 0.2.6 | 2026-05-26 | 133d |

All ≥ 7d. Baseline executor suite on origin/main (`npm ci --ignore-scripts && node --test`, local node 25.6.1;
CI uses node 20): **650 tests / 650 pass / 0 fail**.

## 2–4. After C2 — executor/ (`npm install --ignore-scripts`)
- `npm ls ws --all --package-lock-only`: `viem@2.47.10 → ws@8.21.0 overridden`, `isows → ws@8.21.0 deduped`; no `invalid`.
- `node -e 'console.log(require("ws/package.json").version)'` → `8.21.0`.
- Lockfile diff: 3 lines (ws version/resolved/integrity only). Suite: **650 / 650 pass / 0 fail** (= origin/main).
- Chose 8.21.0 (the Dependabot target) rather than mirroring the parent's 8.21.1: the brief names 8.21.0; both are ≥ 7d.

## 2, 4. After C3 — order-engine/ (`npm install --ignore-scripts --legacy-peer-deps`)
- `npm ls adm-zip tmp --all --package-lock-only`: `hardhat → adm-zip@0.6.1 overridden`, `solc → tmp@0.2.6 overridden`; old versions gone.
  Lockfile diff: adm-zip, tmp, and removal of `os-tmpdir` (dropped by tmp 0.2.x). Nothing else re-resolved.
- **Premise correction:** a plain `npm ci`/`npm install` in order-engine/ fails ERESOLVE on origin/main already
  (chai@6.2.2 vs toolbox's `hardhat-chai-matchers ^2.1.0` peer). The root `.npmrc` (`legacy-peer-deps=true`)
  is not read for this nested project. Used `--legacy-peer-deps` to match how the existing lock was built; `.npmrc` untouched.
- Toolchain: `node compile.js` (solc 0.8.28 direct) exit **0** before and after. `hardhat compile` exit **1** before
  and after with the same `HHE3: No Hardhat config file found` (hardhat 3 ignores `hardhat.config.cjs`) — pre-existing,
  so the downloader cannot be driven via the CLI. Smoke-tested its exact call instead (`downloader.js:264-268`:
  `new AdmZip(p).extractAllTo(dir)`) on 0.6.1 → ok; solc's only tmp call (`smtsolver.js:58` `tmp.fileSync`) on 0.2.6 → ok.
- `package.json` `test` script is a stub (`exit 1`); nothing in CI runs order-engine npm scripts.
