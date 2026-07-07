# CHORE-DEPS-TRIAGE-JUN19 — triage the 7 open Dependabot PRs (batch safe, isolate sensitive)

~7 open Dependabot PRs have accumulated. Triage + verify, batch the safe ones for the owner to merge, isolate
the sensitive/held ones — same disciplined flow as CHORE-DEPS-2. The Code Agent can't merge PRs; it produces a
verified triage + a branch with the safe bumps applied. Be paranoid about TRANSITIVE effects (qr@0.6.0 crash,
ua-parser-js AGPL, P184 dup-WC-cores lessons). Branch off latest `origin/main`. CI green; SSH-signed; FEEDBACK.

## Known state (verify current list — it may have changed)
- ✅ likely safe: **js-yaml #198** (4.1.1→4.2.0), **tar #196** (7.5.13→7.5.16) — patch/minor, low blast radius.
- 🟠 mobile: **@capacitor/core #191** (8.2.0→8.4.0, green) + **@capacitor/cli #190** (8.2.0→8.4.0, RED) — must
  go TOGETHER + needs iOS/capacitor-sync verification; isolate from the app batch.
- 🔴 hold: **viem #148** (2.47.4→2.52.2) — couple with the deferred wagmi-v3 sprint (ADR-008); do NOT bump alone.
- Any others currently open → triage them too.

## Workflow
1. **Triage → `Audits/DEPS-TRIAGE-2026-06-19.md`:** every open Dependabot PR → semver class, blast radius
   (core runtime / CI-only / isolated contracts·order-engine·mobile), transitive-tree check (NO new duplicate
   of @walletconnect/core·viem·qr·coinbase-sdk; NO new AGPL/GPL; NO breaking transitive), recommendation
   (safe-batch / verify-isolated / hold).
2. **Safe batch on `chore/deps-safe-batch-4`:** apply the low-risk bumps together; run tsc + lint + full vitest
   + next build + test-contracts + **`node scripts/audit-gate.mjs`** (must stay 0 blocking) + the
   **catalog-address-guard** (must stay green). **Critical: do NOT undo the #208 override pins**
   (undici 7.28.0 / form-data 4.0.6 / vite 8.0.16) — verify they survive the bumps + `npm audit` stays clean.
   Keep single-instance invariants. Signed commits — this is the batch the owner merges.
3. **Isolate, do NOT batch:** viem (wagmi-v3 coupling — hold), @capacitor/* (mobile, verify iOS, #190 red —
   diagnose why), any major. Per-PR disposition: green-safe vs needs-follow-up.

## Do NOT
- Don't merge/push to main; safe batch on its own branch for the owner. Don't bump viem alone. Don't break the
  audit-gate or catalog-guard or the #208 overrides. App behaviour unchanged; mainnet byte-identical.

## Output
- `Audits/DEPS-TRIAGE-2026-06-19.md` + `chore/deps-safe-batch-4` (verified safe bumps, signed, all gates green
  incl. audit-gate + catalog-guard) + per-PR disposition for held/sensitive. No Auditor.
