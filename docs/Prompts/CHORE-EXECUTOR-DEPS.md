# CHORE-EXECUTOR-DEPS — declare the executor's missing runtime dependencies

The keeper `contracts/order-engine/executor/` imports packages that are **not declared** in its
`package.json`, so a clean install fails at runtime. Confirmed: `@aws-sdk/client-kms` is imported
dynamically in `kms-signer.js` (`await import("@aws-sdk/client-kms")`) but is NOT a dependency — a fresh
`npm install` + run dies with `ERR_MODULE_NOT_FOUND: Cannot find package '@aws-sdk/client-kms'`. Fix the
dependency manifest so a clean prod install works. No logic changes.

## Requirements
- **Audit imports vs declared deps** for the executor package: scan `executor.js`, `kms-signer.js`, and any
  sibling modules for every `import`/`require`/dynamic `import()` of an external package, and reconcile
  against `contracts/order-engine/executor/package.json` `dependencies`. Add every missing runtime package.
  Known-missing: **`@aws-sdk/client-kms`**. Also check the **Vault** path in `kms-signer.js` (VAULT_ADDR /
  VAULT_TOKEN / VAULT_KEY_NAME) — if it uses an HTTP client lib (e.g. `node-vault`) declare it; if it uses
  built-in `fetch`, no dep needed (note which). Verify `viem`, `@supabase/supabase-js`, `dotenv`, etc. are
  all declared if imported.
- **Pin to specific versions** consistent with what the code expects (don't introduce a major bump that
  changes behaviour). Use the AWS SDK v3 line that matches the `@aws-sdk/core`/`@smithy/*` already pulled in.
- **Prove the fix:** in a clean checkout of the executor dir, `rm -rf node_modules package-lock.json &&
  npm install`, then a smoke import of both entrypoints with NO env (it should fail only on missing *config*,
  NOT on `ERR_MODULE_NOT_FOUND`). Capture the before/after in FEEDBACK.
- **npm audit:** the executor currently reports vulnerabilities (1 moderate, 1 high). **Report** them in
  FEEDBACK (package + severity + whether prod-path) — do NOT run `npm audit fix --force` (can break things;
  keep-npm discipline). Flag any high that's on the runtime path for Architect triage.

## Do NOT
- No changes to executor signing/execution logic, the contract, or the app (`src/`). Manifest + lockfile only.
- Don't bump unrelated packages or change majors. SSH-signed commit; append FEEDBACK.

## Output
- Branch `chore/executor-deps`; updated `contracts/order-engine/executor/package.json` + lockfile; clean
  `npm install` + smoke-import proof in FEEDBACK; npm-audit report (no force-fix). Note whether CI covers the
  executor package (if not, state the manual verification done). No Auditor needed.
