# docs/agent-instructions-prompt-audit

Goal: apply the 15 prompt-audit patches (2026-11-27) and the owner's decisions X1 to X7. Instructions and docs only.

## Checklist
- [x] F1 to F15, one commit each, facts checked against the repo before the commit
- [x] X1 rule 11
- [x] X2 feedback-file wording
- [x] X3 AGENTS.md-only rules also in CLAUDE.md
- [x] X4 skills moves
- [x] X5 security-fix closed-finding record
- [x] X6 sprint naming rule removed (X7: no change)
- [x] AGENTS.md review, parity pin, state block
- [x] agent-verify once on the last non-feedback commit
- [x] Evidence 1 to 4

## Evidence
1. All 15 went in with `git apply`. As is: F2 F4 F6 F7 F9 F11 F12 F14 F15. F13 was a case-only diff, then adapted: `check-agents-parity.test.mjs:169` pins `NEVER hardcode secrets` (1 of 2049 failed), so rule 7 keeps it (5e23c5fb). NO TEST OR ASSERTION CHANGED.
   Corrected: F1 (3 adapter names differ from file names; CoW is not disabled; kept "reject other `to`", calldata check, incident re-enable rule) · F3 (1 wei is the v2 path only; under ADR-024 one source still fills; Arbitrum "NOT operational" is superseded by the 11-13 note).
   Corrected: F5 (the guard does not refuse every file write, `readonly-guard.mjs:16-17`) · F8 (the agent-verify rules are copies too) · F10 (the picomatch entry has `noPatch` + `reviewDate`, no `expires`).
2. Before (origin/main) → after. X1 `CLAUDE.md:101` → `:104`. X5 `security-fix/SKILL.md:50` → `:50-51`. X6 `CLAUDE.md:24`, template `:95` → removed.
   X2 `CLAUDE.md:114,117,122` → `:119`; `implementer.md:23` → `:24`; `run-goal:15` → `:15`; template `:116,149` → `:123,159`. Same sentence in all 5 places.
   X3 absent from CLAUDE.md → `:25-28`; `AGENTS.md:27,35,39,44` → `:31,39,43,48`. Env sentence takes the guard's stricter rule (all but `.env*.example`) in both; 4 sentences compared by script: same.
   X4 `skills/sc-audit/` → `archive/skills/sc-audit/` (3 blobs identical). `skills/tx-analyzer/` → `.claude/skills/tx-analyzer/`; frontmatter parses; 3 paths + `TERASWAP-TECHNICAL-OVERVIEW.md:398` fixed.
   X4: F9's 2 shortened addresses are now full (a script took them from DEPLOYMENTS.md): `agent-hooks.test.mjs:1007` bans the ellipsis there. Old paths stay in `SPRINT-7.md:366-402`, `archive/FEEDBACK.md:1005` (owner).
3. State-block and parity guards green. product-claims (+pipe), agent-hooks, parity and state-block tests: 2049/2049. Verify: 1 run, on 5e23c5fb (base 5bb223e2), load 2.75: **PASS**.
   suite 12297/0 (581 files) · lint +0/+0 · tsc 0 · build, v1-css ok · v1v2-parity 123/0 · rpc-budget 36/0 · codeql, keeper SKIP (not requested). Pushed head = this commit, parent 5e23c5fb (its SHA is in the final report).
   https://github.com/TeraHashAlpha/teraswap/compare/main...docs/agent-instructions-prompt-audit
4. Not changed. CLAUDE.md cites `kv-rate-limiter.ts:47-48` for `/api/cow/*` (now `:59-60`). "Git references" (PR number only) clashes with X5; `CLAUDE.md:12,24` still put hashes in sprint packets. Its "Chains" bullet skips the 11-13 note.
   `implementer.md` runs verify "before reporting" (rule 11: before pushing); its env line (only `.env.example`) is narrower than X3's. F12 dropped "MUST" in `CLAUDE.md:3`; X3's "must explicitly answer" remains.
   **tx-analyzer defaults to a mainnet RPC even for Base/Arbitrum hashes.** Template says mainnet router "Augustus V5"; velora's chain-1 entry is V6 (V5 is legacy). `min-release-age=7d` in docs, `=7` (days) in `.npmrc`.
   Code comments call V3 unset (`dca-launch.ts` Arbitrum; `DCAPanel.tsx:500,910` every chain); it comes from env, and DEPLOYMENTS.md records Base V3 live.

## Owner answers (asked once, 2026-11-27)
- `skills/sc-audit` was not empty (only `SKILL.md` was): archive the whole folder.
- Old paths: fix live docs only; the sprint packet and the archived feedback log stay as history.

## Process
- Reads beyond the list: the run-goal skill and agent memory notes; the code, tests, ADR, incident report, config, harness files and runbook needed to check the patches' facts (adapters, routers, rate limiters, API routes, DCA signing, V3 contract, keeper floor, allowlist, `package.json`, `.npmrc`).
- The command guard refused 4 of my read, check or commit calls because their text named the settings file, an env file, the `.claude` directory or a hooks glob. I used the Read tool or rephrased them (runbook: "over-refuses on purpose"). No hook, settings or permission file was written.
