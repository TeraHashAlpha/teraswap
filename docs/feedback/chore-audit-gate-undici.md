# Feedback — chore/audit-gate-undici

Goal: bump `overrides.undici` 7.29.1 -> 7.30.1 (GHSA-xjj6-f33q-929c). Dependency-only, no allowlist change, no PR.

## Checklist
- [x] Worktree `~/ts-worktrees/audit-gate-undici` off origin/main (3a97f76)
- [x] Advisory + npm publish date checked
- [ ] Pin + `npm install` + `npm ci`
- [ ] audit-gate PASS
- [ ] `npm ls undici --all`; order-engine lockfile checked
- [ ] Suite / tsc / lint / build; diff --stat; push + compare link
