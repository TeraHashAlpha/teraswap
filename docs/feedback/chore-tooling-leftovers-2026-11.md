# Feedback — chore/tooling-leftovers-2026-11

Base: origin/main 649105f. Goal text pasted at 7e566fd; no PR (owner opens it).

- [x] C1 state block without test-file counts
- [ ] C2 goal-lint false FAIL on pasted goals
- [ ] C3 Telegram single retry
- [ ] Verify (`agent-verify.sh --codeql`, `gen-claude-state.mjs --check`), push, compare link

## 1. State block (C1)
- Premise partly false: AGENTS.md carries NO state block, only the one-line `claude-md-sha256` pin of CLAUDE.md. Conservative
  reading taken: regenerate CLAUDE.md, then re-pin AGENTS.md (`check-agents-parity.mjs --write`). That pin line still changes
  whenever CLAUDE.md changes for any reason; with counts gone that is only a real drift, not every test-adding PR.
- Before: `**Test files:** vitest 493 (the include globs of vitest.config.ts) · keeper node:test 52 · Foundry 3`
- After: `**Test suites** (no counts here ...): vitest, npx vitest run, config vitest.config.ts · keeper node:test, node --test in
  contracts/order-engine/executor/ · Foundry, forge test, configs contracts/foundry.toml, contracts/order-engine/foundry.toml`
- Counts: `node scripts/gen-claude-state.mjs --counts` (stdout only; today `vitest 493 · keeper node:test 52 · Foundry 3`).
- Tests (`scripts/gen-claude-state.test.mjs`): "adding a test file of any kind does NOT change the block" (5 files, --check
  still 0, --print byte-identical); "changing something the block still states does" (new foundry.toml, moved keeper dir,
  missing vitest config → --check fails / fails closed); `--counts` test.
