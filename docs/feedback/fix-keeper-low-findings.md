# fix/keeper-low-findings — feedback (A71b S-1..S-4, A73d L-1..L-2)

Base origin/main `f7c4887`. Auditor-note: keeper code, Lows only — owner opens the PR as DRAFT.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-low-findings
- [x] S-1 · [x] S-2 · [x] S-3 · [x] S-4 · [x] L-1 · [x] L-2 · [x] suites both Nodes · [x] CodeQL · [x] pushed

## 1. Per-finding (one commit each; "fails on main" = its test files vs that commit's source reverted to f7c4887)
| id | commit | file | change | test | fails on main |
|---|---|---|---|---|---|
| S-1 | 60279e8 | rpc-auth.js onRpcSuccess; event-watcher.js (poll) | clear only when `streaks.size === 0`; watcher reports `event-watcher:poll` success | rpc-auth-pause-clear.test.mjs | 3/4 |
| S-2 | 4cf8a7b | rpc-auth.js readOwnedState/writeOwnedState | `lstat`, refuse symlinked dir; `O_NOFOLLOW` read+write | rpc-auth-state-dir-symlink.test.mjs | 4/6 |
| S-3 | 769e540 | redact.js SCHEME_URL, ENCODED_SLASH/COLON | no lookbehind (leftmost); decode `%2F` `%252F` `/` `\x2f` `&#x2F;` `&#47;` `&sol;` first | redact-shapes.test.mjs | 19/31 |
| S-4 | 5631c2f | EXECUTOR-OPERATIONS.md §7 | `grep -iF` / `-HniF` | runbook-rpc-inventory.test.mjs (runs the block) | 2/3 |
| L-1 | 93873a5 | retry-policy.js collectErrorText | one `MAX_CAUSE_DEPTH = 10` for both walks | retry-policy-chain-depth.test.mjs (real viem BaseError chains) | 5/6 |
| L-2 | a36fd09 | rpc-auth.js classifyRpcError | viem's guessed revert (InternalRpcError, no ExecutionRevertedError, no hex data) is not a revert | rpc-auth-internal-rpc-error.test.mjs (readContract/writeContract vs the stub) | 4/10 |
Extra commit 0ed3f6d: two runbook rows (recovery wording, −32603+auth words ⇒ rpc-auth). L-2: `rpc-transport` → `rpc-auth`, still infra.

## 2. Redaction shapes (key `TESTKEY`; before f7c4887 → after)
glued `0x`+40 hex+`https://…` LEAK→clean · 30 glued letters LEAK→clean (26: already clean; boundary was exactly 27) ·
`host%2Fv2%2Fkey` / `%2f` / `%252F` / `https%3A%2F%2F…` / schemeless `%2F` LEAK→`https://host/REDACTED` ·
`/`, double-escaped, `&#x2F;` LEAK→clean · `&#47;` clean→clean · controls (plain, `\/`, `rpc_https://`) clean→clean.

## 3. Suites
Keeper `node --test` 1025/1025 (base 976, +49): Node 20.20.2 (`npm ci --ignore-scripts`) 3/3 runs, Node 22.23.4 (`npm ci`) 3/3 runs, 0 cancelled.
vitest 415 files / 6674 · tsc 0 · eslint 93 warnings (limit 94; every changed file is ESLint-ignored).
CodeQL `security-extended` (CI's suite): origin/main 13 → branch 13, no per-rule/file difference.

## 4. Diff
`git diff --stat origin/main`: 12 files, +679 −24 (excl. this file: 11 files, +641 −24) — 4 src (rpc-auth, redact, retry-policy, event-watcher), 6 tests (one extended: runbook-rpc-inventory, redact-shapes), 1 runbook + this file.

## Notes
- Node 20/22 are not on the host: official tarballs, SHA-256 checked against nodejs.org, run from the session scratchpad.
- Extra read (premise check, grep + 2 line ranges): onRpc* call sites in event-watcher.js/executor.js. S-1's premise held: the
  watcher tags its processing phase `event-watcher:poll` but never reported success for it. No deadlock: a paused cycle still
  returns normally, so `cycle`/`balance-read` keep reporting (idle mode only slows it).
- S-3 "`/` encodings": the goal text shows a bare `/`; read as the other slash escapes and covered all of them (over-decoding only over-redacts).
- Edge (S-1): an origin that stops being called holds the pause; every current origin is called each poll/cycle.
- Edge (S-2): a refused write means "not persisted", so a symlinked state dir alerts on every boot (louder, by design).
