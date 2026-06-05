# SPRINT-9I — Dependency maintenance (triage the open Dependabot PRs)

10 open Dependabot PRs (all bot-authored, dependency bumps). None block the live Base arc. Goal:
**triage and verify them locally**, batch the safe ones, isolate the sensitive ones, and scope the
wagmi v3 migration separately. The Code Agent cannot merge GitHub PRs — it produces a verified
triage + a branch with the safe bumps applied for the owner to PR/merge.

## Open PRs (as of 2026-06-02)
- #124 `viem` 2.47.4 → 2.51.0 — **SENSITIVE** (core to adapters/chains/wagmi)
- #123 `@capacitor/cli` 8.2 → 8.3.4 · #120 `@capacitor/core` 8.2 → 8.3.4 — **SENSITIVE** (mobile/iOS build)
- #122 `@capacitor/browser` 8.0.2 → 8.0.3 — patch, likely safe
- #121 `@upstash/redis` 1.37 → 1.38 — minor (rate-limit/KV); verify
- #100 `gitleaks-action` 2.3.6 → 2.3.9 · #99 `codeql-action` 3.28.10 → 4.36.0 — CI actions (codeql is a MAJOR — check workflow compat)
- #94 ws + viem + hardhat-toolbox · #93 axios 1.14→1.16.1 · #92 serialize-javascript + hardhat-toolbox — all in `/contracts/order-engine` (isolated package, low app risk)

## Workflow
1. **Triage (no guessing):** for each PR, determine semver class (patch/minor/major) and blast radius
   (core runtime vs CI-only vs isolated contracts package). Produce `Audits/DEPS-TRIAGE-2026-06-02.md`
   with a table: PR, bump, class, risk, recommendation (safe-batch / verify-isolated / hold).
2. **Verify the SAFE batch locally:** on a branch `chore/deps-safe-batch`, apply the low-risk bumps
   (patch/minor, non-core: @capacitor/browser, @upstash/redis, the /contracts/order-engine bumps,
   gitleaks-action) together; run full `tsc` + `lint` + test suite + `next build`. Only keep bumps
   that stay 100% green. Commit (signed). This is the batch the owner can merge.
3. **Isolate the SENSITIVE ones — do NOT batch:** `viem` 2.51 (re-run the full adapter/chains/swap
   suite + a Base + mainnet quote smoke; viem touches encoding/clients), `@capacitor/core`+`cli` 8.3
   (mobile build — verify `next build` + capacitor sync, note iOS implications), `codeql-action` v4
   (CI workflow syntax compat). For each: report whether it's green-and-safe or needs follow-up; do
   NOT bundle them with the safe batch.
4. **Scope wagmi v3 (ADR-008) — DO NOT implement here.** The 22 moderate npm-audit alerts are
   transitive under @reown/appkit / @wagmi/connectors and only close with the wagmi v3 major. Write a
   short scoping note (impact, breaking changes, files touched, test plan) for a dedicated future
   sprint. The viem 2.51 bump (#124) should be evaluated together with that migration, not alone.

## Do NOT
- Do NOT merge or push to main; commit the safe batch on its own branch for the owner.
- Do NOT bundle sensitive (viem / capacitor / codeql-major) bumps with the safe batch.
- Do NOT change app behaviour; bumps only. Mainnet + Base must stay green. Keep keys server-only.
- Each commit signed; CI green; append FEEDBACK.

## Output
- `Audits/DEPS-TRIAGE-2026-06-02.md` (triage table + recommendations).
- `chore/deps-safe-batch` branch with the verified safe bumps (signed commits, green).
- A wagmi-v3 scoping note (deferred sprint).
