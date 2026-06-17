# CHORE-HYGIENE-1 — cleanup sprint (H2 pending-baseline + Dependabot re-triage)

Two Code-Agent items, each its OWN atomic SSH-signed commit (or branch). Always work off **latest
`origin/main`** (it already contains #177/#178/#179 — gitleaks rule, H2 fail-closed, tsparticles removed).
CI green incl. the real **test-contracts** gate; append `FEEDBACK.md`. Mainnet byte-identical; keys
server-only; no contract/Solidity/adapter/oracle-gate changes. Branch `chore/hygiene-1`.

---

## A — H2 "pending-baseline" vs hard-fail distinction

**Context.** PR #177 (P2) made H2 (TLS/DNS fingerprint baseline, `src/lib/fingerprint-validator.ts` +
the H2 block in `src/lib/monitoring-loop.ts`) **fail-closed** instead of a vacuous pass. BUT the
committed `data/endpoint-baseline.json` is an **intentional placeholder** (`generatedAt: null`, empty
`endpoints`, note "populate after Cloudflare migration"). So H2 is *expected* to have no baseline right
now — that's a known, planned state, not a fault.

**Goal.** H2 must distinguish two empty-baseline cases so a known-pending state does NOT fire paging:
1. **`pending-baseline`** — baseline file present but is the placeholder (`generatedAt === null` and/or
   empty `endpoints`). This is EXPECTED (pre-Cloudflare-migration). Report as an explicit informational
   status (e.g. `pending` / `not-configured`) that surfaces in the health output but does **NOT** count
   toward "unhealthy" and does **NOT** trip the watchdog / kill-switch / Telegram P0 alert.
2. **`degraded` / fault** — baseline file missing entirely, unparseable, or malformed in a way that
   isn't the known placeholder. This stays fail-closed (the P2 behaviour) — surfaced as degraded.

**First, investigate & report (don't guess):** trace exactly what the current P2 fail-closed does on
`origin/main` — does H2-degraded merely appear in the health/tick output, or does it actually trigger
the watchdog / kill-switch / Telegram P0 / source `forceDisable`? Put the finding in FEEDBACK.
- If degraded is already **non-paging/informational**, this item is mostly **labelling**: introduce the
  explicit `pending-baseline` status + message so it's not confused with a real fault, and add a test.
  Say so in FEEDBACK and keep the change minimal.
- If degraded **does** page/disable, implement the two-way split above so `pending-baseline` is
  non-paging while genuine missing/corrupt stays fail-closed.

**Tests.** (a) placeholder baseline (`generatedAt:null`, `endpoints:{}`) → status `pending-baseline`,
asserts NO paging/forceDisable/kill-switch path is hit; (b) missing/corrupt baseline → `degraded`
fail-closed; (c) a populated baseline → normal validation runs (existing behaviour unchanged). Reset the
module cache between cases (`resetBaseline()` exists). Document the trigger for exiting `pending-baseline`
(seed `data/endpoint-baseline.json` post-Cloudflare migration) inline.

---

## B — Dependabot re-triage + safe batch (refresh)

**Context.** A batch of Dependabot PRs has been held (per `Audits/DEPS-TRIAGE-2026-06-12.md` and prior
notes): viem (#148, #175 ws+viem), capacitor (#120/#123), undici (#174), toolbox (#94). A month has
passed — re-triage with fresh eyes. The Code Agent cannot merge PRs; produce a verified triage + a
branch with the safe bumps applied for the owner to PR/merge. Same disciplined flow as CHORE-DEPS-2.

**Do.**
1. Refresh the triage into `Audits/DEPS-TRIAGE-2026-06-13.md`: every currently-open Dependabot PR →
   semver class, blast radius (core runtime / CI-only / isolated contracts·order-engine), transitive-tree
   check (NO new duplicate of @walletconnect/core·viem·coinbase-sdk·qr, NO new AGPL/GPL transitive — the
   ua-parser-js lesson, NO breaking transitive — the qr lesson), recommendation (safe-batch /
   verify-isolated / hold). **Flag `undici` (#174) explicitly** — if it's a security patch, prioritise it.
2. Apply the SAFE batch on `chore/deps-safe-batch-3`: low-risk patch/minor non-core + CI actions
   together; run tsc + lint + full suite + next build + test-contracts. Keep only bumps that stay 100%
   green and preserve the single-instance invariant (one each of @walletconnect/core, qr@0.5.5, viem,
   coinbase-sdk). Signed commits — this is the batch the owner merges.
3. **Isolate, do NOT batch:** viem (couple with the deferred wagmi-v3 sprint per ADR-008 — do NOT bump
   alone), @capacitor/* (mobile build), any major. Per-PR disposition: green-and-safe vs needs-follow-up.
4. `#94` toolbox supersedes `#92` (owner will close #92 in the UI). Note any contracts/order-engine
   dev-tooling bumps as isolated (out of the app safe-batch; verify they don't perturb the Foundry gate).

---

## Do NOT
- No contract / Solidity / adapter / oracle-gate / FeeCollector changes. Do NOT bump viem alone
  (wagmi-v3 coupling, ADR-008). Do NOT hand-edit `package-lock.json` (clean `npm install`).
- Mainnet byte-identical (test-guarded). Keys server-only. Each commit SSH-signed. Append FEEDBACK.

## Output
- Branch `chore/hygiene-1` — item A (H2) as a signed commit + the investigation finding in FEEDBACK.
- `Audits/DEPS-TRIAGE-2026-06-13.md` + branch `chore/deps-safe-batch-3` (verified safe bumps, signed,
  green) + per-PR disposition for held/sensitive ones.
- No Auditor needed (light cleanup). Flag for Architect if A's investigation shows degraded currently
  pages (changes the blast radius), or if the triage surfaces any security-relevant bump beyond undici.
