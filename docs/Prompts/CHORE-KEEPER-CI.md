# CHORE-KEEPER-CI — run the keeper's node:test in CI

Audit gap (SPRINT-201): the self-hosted keeper's tests (`contracts/order-engine/executor/`, 18/18 via
`node --test`) do NOT run in CI, so a future change can break them silently. Add a CI job that runs them on
every PR. Branch `chore/keeper-ci` off latest `origin/main`. **Touches `.github/workflows/` only** (disjoint
from app/api/executor source — safe to run alongside other branches). SSH-signed commit; FEEDBACK.

## Requirements
- Add a CI job (extend the existing CI workflow with a new job, or a small `keeper-tests.yml`) that:
  - checks out the repo, sets up Node 20,
  - `cd contracts/order-engine/executor && npm ci` (the deps are now declared after #194),
  - runs `node --test` over the executor's test files (the 12 freeze-score + 6 alert = 18 tests),
  - fails the PR if any keeper test fails.
- Keep it fast + isolated; do NOT make it depend on secrets/RPC/Supabase (the keeper tests are unit tests
  with mocked I/O). If a test needs an env var to import, provide a dummy in the job.
- Do NOT change the existing jobs (build/lint/test/test-contracts/audit/CodeQL) — only ADD the keeper job.

## Verify
- The new job passes on this branch (18/18). Intentionally break one keeper test locally to confirm the job
  goes red, then revert. Note the before/after in FEEDBACK.

## Output
- Branch `chore/keeper-ci`; the new CI job; FEEDBACK with the job definition + the red/green proof. No Auditor.
