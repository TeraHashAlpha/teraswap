# fix/revoke-chain — FEEDBACK (Code Agent; 2026-11-04)

## Checklist
- [x] Worktree ~/ts-worktrees/revoke-chain off origin/main f2b6bcd (#649, B8 merged), real `npm ci`, SSH-signed noreply committer
- [x] C1 records carry the chain (+ versioned reader, fixtures) · [x] C2 revoke is chain-bound (shared hook, v1 + v2 rows) · [x] C3 "revoked" means revoked (receipt status success on the record's chain; reverted/rejected → Retry, record open)
- [x] Verify (suite vs origin/main, lint delta 0, tsc, build, rpc-budget guards, CodeQL full suite) · [x] push + compare link

## Premises that were false (owner answer pending — the default applied is stated; the answer supersedes this text)
- "Versioned migration of the persisted store": `useActiveApprovals` is in-memory zustand (`create`, NO persist middleware); nothing
  is on disk and a reload empties it, so no stored record can lack `chainId`. Default: `APPROVAL_RECORD_SCHEMA_VERSION = 2` +
  `readApprovalRecord()` reads the schema-1 shape (no chainId) as chain-unknown; NO storage added (FE-01 localStorage debt is open;
  persisting approvals is the owner's call — say so and it is one more commit).
- "useApproval … records approvals": it does not. The only writers are the two CoW paths (`SwapBox.tsx:452`, `use-swap-lifecycle.ts:215`),
  both `needsRevoke: false` → in production NO record is ever actionable; the panel and this bug are reachable only via tests or a
  future writer (e.g. recording the exact approve `useApproval` sends). Left as is: what gets recorded is out of scope.
- "the tx's chain": no hook exposes the chain a tx was sent on; the closest in-scope source is wagmi `useAccount().chain?.id` at write
  time (the connector's chain = the chain wagmi sent the swap/approve on), with NO `?? 1` fallback → undefined = unknown, never guessed.
- "viem `chain` param": wagmi 2.19 `writeContract({ chainId })` passes `chain: { id }` to viem (it does not assert itself —
  `assertChainId: false`); viem `sendTransaction` runs `assertCurrentChain` at send time → ChainMismatchError, nothing sent.
- "if v1 re-reads allowance": it does not (only `useApproval` refetches after an approve) → no allowance re-read added.
- Extra read (off the list): the two CoW cases of `execution.lifecycle.test.tsx` (sell side is native ETH → no record is written there,
  so no write-site test; write-site evidence is tsc — `chainId` is a required key of `addApproval` — plus the lines below).

## Content-map delta (v1 → v2; both rows render ONE hook, so v1 gets every change too)
- Added to BOTH rows: the record's chain name in the meta line (`Exact allowance · Base · 17d ago`); v1 SwapButton's "Switch to {chain}"
  when the wallet is elsewhere; the one owner-approved addition for a chain-unknown record: "Network unknown — reconnect on the chain
  where you approved" (no button). Parity test: v1 text nodes == v2 text nodes, same order (3 chains + unknown).
- Behaviour deltas vs v1 (the fix): the revoke write carries `chainId`; a reverted receipt no longer prints "✓ Revoked"; v1's render-time
  `markRevoked` now runs in the hook's effect (one tick later, same vanish).

## Evidence
1 Data path. BEFORE: no chain on the record (`useActiveApprovals.ts:8-21`); v1 `ActiveApprovals.tsx:20` read the WALLET's chain, `:42`
  sent approve(spender,0) with no chainId (→ wallet's chain), `:71` linked the receipt on the wallet's chain; v2 `ApprovalsPanel.tsx:24/:41/:65`
  the same; both printed "revoked" on the receipt QUERY's success (`:60`), true for a reverted tx too. AFTER: `useActiveApprovals.ts:36`
  `chainId: number | undefined`, written by `SwapBox.tsx:463` / `use-swap-lifecycle.ts:224` from `useAccount().chain?.id`;
  `useRevokeApproval.ts:86` refuses a press off the record's chain, `:91` `writeContract({ chainId: record.chainId })` → viem
  `assertCurrentChain`, `:64` receipt awaited on the record's chain, `:110` explorer link on the record's chain, `:72` revoked ⇔ receipt
  `status === 'success'`. Rows (v1 `ActiveApprovals`, v2 `ApprovalsPanel`) only render the hook's action.
2 Migration + unknown: see premise 1. Reader: schema-1 → `chainId: undefined`; non-positive-integer → undefined; never defaulted (10 unit
  tests). Unknown record: v1's copy + the neutral line, counted in the badge, no Revoke/Switch, no write (v1 + v2, parity-checked).
3 Test matrix (`approvals.test.tsx`, fake wagmi, nothing sent): Base record + wallet on Ethereum → "Switch to Base" (v1 + v2),
  `switchChain({8453})`, 0 writes; after the switch → write `chainId: 8453`, token/spender/function = the record's; third-chain landing →
  still "Switch to Base", 0 writes; mid-flight mismatch → no hash, record open, Switch offered (no Retry off-chain); unknown → no send;
  receipt watcher pinned to the record's chain through a wallet change; explorer `new URL().hostname` per record chain 1/8453/42161 with
  the wallet elsewhere (v1 + v2); C3: success receipt → revoked (store marked only then); fetched-but-reverted / watcher error /
  query-success-without-receipt / wallet rejection → Retry + record open (v2 and v1). v1-parity tests UPDATED (behaviour changed by the
  fix): "a press calls approve(spender,0)" expects `chainId`; "Revoking… → Confirming… → ✓ Revoked" needs a success receipt + record-chain
  watcher; "revoke tx link follows the active chain" → the RECORD's chain; "rejected write → Retry" asserts `chainId`. Sibling mocks
  (portfolio-a11y / portfolio-chain / portfolio.test) gained `useSwitchChain` (+ `useAccount` in a11y): mock surface only.
4 CodeQL javascript-security-extended (gh codeql 2.27.2, full DB): main 19 alerts → head 19, identical set, 0 new, 0 in changed files.
  Suite 409 files / 6485 tests (origin/main) → 410 / 6507, all green; lint 93 warnings / 0 errors = 93 / 0; tsc 0; `next build` OK;
  rpc-budget guards green (v1 + v2, states a0/a/b/c/c20/p; no new RPC: `useSwitchChain`/`useAccount` read the connector).
5 `git diff --stat origin/main`: 12 files, +588 / −131 (code commits C1 c371c29 · C2 72fc88f · C3 8e5939d, all SSH-signed) + this file.
  Not touched: swap/approve amounts, Permit2, gates, order paths, deps, secrets. Compare:
  https://github.com/TeraHashAlpha/teraswap/compare/main...fix/revoke-chain
