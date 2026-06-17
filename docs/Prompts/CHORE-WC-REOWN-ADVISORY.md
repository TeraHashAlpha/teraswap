# CHORE-WC-REOWN-ADVISORY — fix the WalletConnect/Reown audit-gate failure

A newly-published advisory makes `npm audit --audit-level=high` fail on the **unchanged root lockfile**, so
**main itself is red** and every open PR shows the audit check failing (e.g. #194). Root cause:
`@walletconnect/universal-provider` (vulnerable) pulled transitively by `@wagmi/connectors` →
`@reown/appkit-*` (all `<=1.8.9`: appkit, appkit-controllers, appkit-pay, appkit-scaffold-ui, appkit-ui,
appkit-utils). 34 vulns total (1 low, 29 moderate, **4 high**). Goal: get the audit gate green again WITHOUT
destabilising the WalletConnect/wagmi stack.

## ⚠️ Hard constraints (this stack has bitten us before)
- **Do NOT pull wagmi v3** (ADR-008 — RainbowKit doesn't support it). Stay on wagmi 2.x.
- **Keep the RainbowKit pin** (2.2.10 — 2.2.11 pulls AGPL ua-parser-js, ADR-012).
- **Preserve the single-instance invariant:** exactly ONE `@walletconnect/core` after the change (the P184
  duplicate-WC-cores incident). Re-check the transitive tree; no new dup cores, no new AGPL/GPL transitive.

## Workflow
1. **Triage (report in `Audits/WC-REOWN-ADVISORY-2026-06-16.md`):** list the 4 HIGH advisories — ID, package,
   vulnerable range, fixed-in version, and whether the vulnerable code is on TeraSwap's runtime path (we use
   RainbowKit; `@reown/appkit-*` come in via `@wagmi/connectors`' WalletConnect connector). Note the Dependabot
   baseline finding (these WC transitives were previously assessed zero-prod-risk) and say whether that still
   holds.
2. **Preferred fix — patched override:** if a patched `@reown/appkit*` / `@walletconnect/universal-provider`
   exists that satisfies the advisory, force it via npm **`overrides`** (the repo already overrides
   `@walletconnect/core`). Pick the minimal bump that (a) clears the 4 high, (b) stays compatible with the
   current `@wagmi/connectors` + RainbowKit 2.2.10 + wagmi 2.19.x, (c) keeps one `@walletconnect/core`.
   Regenerate the lockfile with a clean `npm install` (no hand-edits).
3. **Fallback — allowlist:** if no compatible patch exists yet, add a documented `npm audit` allowlist/ignore
   for the specific advisory IDs (config the CI `audit` step reads) so the gate passes, with an inline TODO to
   drop it when `@wagmi/connectors` ships patched appkit. Justify per the runtime-path assessment.
4. **Verify:** `npm audit --audit-level=high` passes (or only the explicitly-allowlisted IDs remain); tsc +
   lint + full test suite + next build + test-contracts all green; the single `@walletconnect/core` invariant
   holds (`npm ls @walletconnect/core`); WalletConnect connect flow not broken (note manual-verify step).

## Do NOT
- No wagmi-v3, no RainbowKit bump past 2.2.10, no new copyleft transitive. No app-logic changes — deps/overrides
  + audit-config only. SSH-signed commit(s); append FEEDBACK with the `npm ls` tree deltas.

## Output
- Branch `chore/wc-reown-advisory` + `Audits/WC-REOWN-ADVISORY-2026-06-16.md` (triage + the 4-high assessment +
  chosen path). Audit gate green. **Flag for Architect review before merge** (WC stack is sensitive) — do NOT
  rely on Auditor; the Architect signs off given the P184/ADR-008/ADR-012 history.
