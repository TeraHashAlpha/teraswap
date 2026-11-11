# Feedback — chore/agent-harness (2026-11-11, off origin/main 26623b3)

Owner's standing agent rules become repo config. Touches only `.claude/**`, `scripts/agent-*`, `scripts/goal-lint*`,
`.github/pull_request_template.md`, `docs/Runbooks/agent-harness.md`, this file.

## Task checklist
- [x] C1 `.claude/settings.json` + `scripts/agent-settings.test.mjs`
- [x] C2 `.claude/agents/{implementer,recon,auditor}.md` (+ auditor hook)
- [ ] C3 `scripts/agent-verify.sh` (+ formatter test)
- [ ] C4 skills moved to `<name>/SKILL.md` (git mv) + `run-goal`, `audit-pr`
- [ ] C5 PR template, `scripts/goal-lint.mjs` (+ test), runbook

## Evidence
(filled in as each commit lands; final edit = last commit)
