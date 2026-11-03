# Feedback — feat/dependabot-auto-merge

Task checklist (ticked as the branch progresses; final evidence replaces this at the end):

- [x] worktree off origin/main, feedback file first
- [ ] C1 workflow `dependabot-auto-merge.yml` + `scripts/dependabot/auto-merge-eligibility.mjs`
- [ ] C2 fixture tests (one failing fixture per rule + all-pass)
- [ ] C3 runbook section
- [ ] verify: actionlint, suite vs origin/main, lint delta 0
- [ ] dry-run #638–#643 (read-only), evidence 1–4, push, compare link
