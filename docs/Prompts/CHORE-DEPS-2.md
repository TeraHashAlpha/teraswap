# CHORE-DEPS-2 — Dependabot triage (the ~11 open PRs)

~11 open Dependabot PRs have accumulated (some held from 9I). Triage + verify them, batch the safe ones,
isolate the sensitive ones, and apply the held decisions — same disciplined flow as 9I. The Code Agent
cannot merge GitHub PRs; it produces a verified triage + a branch with the safe bumps applied for the
owner to PR/merge. Given our history (qr@0.6.0 crash, ua-parser-js AGPL, P184 dup WC cores), be
paranoid about TRANSITIVE effects, not just the direct bump.

## Workflow
1. **Triage (no guessing):** list every open Dependabot PR; for each determine semver class
   (patch/minor/major) and blast radius (core runtime vs CI-only vs isolated /contracts/order-engine).
   Produce `Audits/DEPS-TRIAGE-2026-06-12.md` with a table: PR, bump, class, risk, recommendation
   (safe-batch / verify-isolated / hold). For EACH bump, check the resulting transitive tree — confirm
   it does NOT introduce a duplicate of a critical dep (@walletconnect/core, qr, viem, coinbase-sdk),
   a new copyleft (AGPL/GPL) transitive (the ua-parser-js lesson), or a breaking transitive (the qr
   lesson). Flag any risky semver range.
2. **Verify the SAFE batch locally:** on `chore/deps-safe-batch-2`, apply the low-risk bumps
   (patch/minor, non-core, CI actions) together; run tsc + lint + full test suite + next build + the
   real test-contracts gate. Keep only bumps that stay 100% green and don't perturb the critical
   single-instance invariant (re-check: one @walletconnect/core, one qr@0.5.5, one viem, one
   coinbase-sdk). Signed commits. This is the batch the owner merges.
3. **Apply the held 9I decisions:** the codeql-action v4 bump → pin to the annotated-tag commit SHA
   `7211b7c8` (NOT the tag-object), with `# v4.x` comment, in .github/workflows/codeql.yml. Verify the
   CodeQL workflow stays green.
4. **Isolate the SENSITIVE ones — do NOT batch:** viem (couple with the deferred wagmi-v3 sprint per
   ADR-008 — do NOT bump alone; re-run the full adapter/chains/swap suite + a Base+mainnet quote smoke
   if evaluated), @capacitor/* (mobile build — verify next build + capacitor sync, note iOS), any other
   major. For each: report green-and-safe vs needs-follow-up; do NOT bundle with the safe batch.
5. **The /contracts/order-engine bumps** (hardhat-toolbox peer conflicts, axios, etc.): these are
   isolated dev-tooling. Per the existing convention, keep them out of the app safe-batch; verify they
   don't affect the (Foundry) contract build/test which is the real gate. Recommend hold/separate.

## Do NOT
- Do NOT merge or push to main; the safe batch goes on its own branch for the owner to PR.
- Do NOT bundle sensitive (viem/capacitor/major) bumps with the safe batch. Do NOT bump viem alone
  (wagmi-v3 coupling). Keep the critical single-instance invariant.
- App behaviour unchanged; mainnet+Base green; test-contracts green; keys server-only. Each commit
  signed; append FEEDBACK with the full triage table + anything surprising in a transitive tree.

## Output
- `Audits/DEPS-TRIAGE-2026-06-12.md` (triage table + recommendations + transitive-tree notes).
- `chore/deps-safe-batch-2` branch with the verified safe bumps + the codeql SHA pin (signed, green).
- Per-PR disposition for the held/sensitive ones.
