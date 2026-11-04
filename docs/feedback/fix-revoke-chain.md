# fix/revoke-chain — FEEDBACK (Code Agent; 2026-11-04)

## Checklist
- [x] Worktree ~/ts-worktrees/revoke-chain off origin/main f2b6bcd (#649, B8 merged), real `npm ci`, SSH-signed noreply committer
- [x] C1 records carry the chain (+ versioned reader, fixtures) · [x] C2 revoke is chain-bound (shared hook, v1 + v2 rows) · [x] C3 "revoked" means revoked (receipt status success on the record's chain; reverted/rejected → Retry, record open)
- [ ] Verify (suite vs origin/main, lint delta 0, tsc, build, rpc-budget guards, CodeQL full suite) · [ ] push + compare link

## Premises checked (owner answer pending — default applied, listed first)
- "Versioned migration of the persisted store": `useActiveApprovals` is in-memory zustand (`create`, no persist middleware) —
  NOTHING is persisted; a reload empties it, so no stored record can lack `chainId`. Default applied: schema version constant
  (`APPROVAL_RECORD_SCHEMA_VERSION = 2`) + `readApprovalRecord()` reads the schema-1 shape (no chainId) as chain-unknown; no
  persistence added (FE-01 localStorage debt is open; adding storage is the owner's call).
- "useApproval … records approvals": it does not. The only writers are the two CoW paths (`SwapBox.tsx` / `use-swap-lifecycle.ts`),
  both `needsRevoke: false` → in production no record is ever actionable, so the panel (and this bug) is reachable only through
  tests or a future writer. Left as is (changing what gets recorded is out of scope).
- Extra read (not on the list): the two CoW cases of `execution.lifecycle.test.tsx` (sell side is native ETH → no record written
  there, so no write-site test was added; write-site evidence is tsc: `chainId` is a required key of `addApproval`).

## Evidence
(filled per commit: 1 data path · 2 migration + unknown chain · 3 test matrix · 4 CodeQL + suite/lint/tsc/build · 5 diff --stat + link)
