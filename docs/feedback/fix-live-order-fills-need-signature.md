# Feedback: fix/live-order-fills-need-signature (A87b R2-1, owner decision 2026-11-18)

Privacy. **Draft PR, Auditor required** (the owner opens it; no PR action here).

## Checklist (ticked as the work lands; the evidence block replaces it at the end)
- [ ] 1. executions route: a live (non-terminal) order needs the wallet's read signature; same helper, terminal set, headers and 401 as by-id
- [ ] 2. browser v1 + v2: every executions call sends the read-signature headers the Orders tab holds; sign-once-and-retry on 401
- [ ] 3. privacy sentence unchanged; proof comment cites the executions route; the pinned live-executions test flips to 401 (CHANGED EXPECTATION)
- [ ] 4. tests: route matrix, seeded property, real browser v1+v2 vs origin/main, mutation proof
- [ ] 5. verify: agent-verify --codeql, gen-claude-state --check, lint delta 0; evidence 1-5
