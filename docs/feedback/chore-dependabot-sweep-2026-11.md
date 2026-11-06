# chore/dependabot-sweep-2026-11 — feedback

Goal: triage 9 open Dependabot alerts on main; pin patched npm releases older than
`min-release-age=7` via `overrides`; allowlist the rest with `expires`. No PR.

## Checklist
- [ ] Commit 1 — facts table (alert · package · versions/path · dependents · patch + date · age · dev/prod · action), incl. ios/ answer
- [ ] Commit 2 — overrides + allowlist per rule; `npm install --package-lock-only` then `npm ci` (root + contracts/order-engine)
- [ ] Verify — audit-gate exit 0; root + keeper suites on Node 20.20.2 and 22.23.4; `npm run build`; lint delta 0
- [ ] Push branch, report compare link, evidence 1–4

## Findings
(filled as work proceeds)
