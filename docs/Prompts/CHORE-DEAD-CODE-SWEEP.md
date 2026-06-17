# CHORE-DEAD-CODE-SWEEP — repo-wide unused code & deps cleanup

A broad, conservative sweep for provably-unused exports, files, and dependencies across the app and the
order-engine executor. Branch `chore/dead-code-sweep` off latest `origin/main`. CI green incl. test-contracts;
SSH-signed commits; append FEEDBACK. No behaviour change; mainnet byte-identical.

## Scope
- **`src/`** — run `knip` (and/or `ts-prune`) to find unused exports, unreferenced files, and unused
  `dependencies`/`devDependencies`. Remove only what is **provably unused**.
- **`contracts/order-engine/executor/`** — remove the **`ethers`** dependency: PR #194 flagged it as
  declared-but-unused (the executor uses viem). Confirm zero `ethers` imports, then drop it from package.json
  + regenerate the lockfile (clean `npm install`, no hand-edits).
- Unused npm deps anywhere else surfaced by the sweep (e.g. leftover libs from removed features).

## Rules (conservative — false positives are the risk)
- Remove ONLY provably-unused. Watch for dynamic usage that static tools miss: dynamic `import()`,
  string-referenced modules, Next.js route/page conventions, files referenced by config/build, test fixtures,
  and anything imported only by type. When in doubt, **leave it and note it in FEEDBACK** rather than risk a
  hidden break.
- **Rule #4:** do NOT delete files referenced by docs/ADRs as historical record; for genuinely orphaned
  source, removal is fine (git history preserves it).
- After EACH logical removal (or grouped batch): `tsc` + lint + full vitest suite + `next build` +
  test-contracts must stay green. Keep commits reviewable (group sensibly or split).
- Do NOT bump versions or change majors — this is removal-only (plus the executor `ethers` drop). Preserve the
  single-instance invariants (@walletconnect/core, qr@0.5.5, viem, coinbase-sdk).

## Do NOT
- No logic/behaviour changes, no contract/Solidity changes, no gate/adapter changes. Removal + manifest/lockfile
  only. Don't touch the WC/audit-gate config from #195.

## Output
- Branch `chore/dead-code-sweep`; the `knip`/`ts-prune` report + full list of every removal (files, exports,
  deps) in FEEDBACK, with the "left it, possibly-dynamic" list separately. CI + test-contracts green. No
  Auditor needed; flag Architect only if a removal touches anything security/gate-adjacent.
