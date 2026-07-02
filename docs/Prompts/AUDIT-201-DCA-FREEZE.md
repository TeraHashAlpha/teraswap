# AUDITOR — PR #201 (sprint/dca-observability-freeze)

Independent security review (Opus 4.8, adversarial sub-reviewers, on-chain verification where relevant,
read-only on source — produce remediation prompts for the Code Agent, never edit). Classify C/H/M/L/I;
**0C/0H = approved**. The sensitive surface: an advisory observability layer + a **manual freeze that gates
DCA order execution** — the user-safety invariant is the crux.

## Context
PR #201 adds, to the live Base keeper + app: Telegram alerts, a 0-20 freeze-urgency score, and a manual
(admin-only) freeze. **The bot must NEVER auto-freeze.** Files: `executor/alert.js`, `executor/freeze-score.js`,
the keeper loop, `api/admin/dca-freeze` (POST/GET), `api/orders` (create), Supabase `circuit_breaker`,
`docs/Runbooks/DCA-FREEZE.md`, `supabase/circuit-breaker.sql`. 1877 vitest (CI) + keeper node:test 18/18
(standalone — NOT in CI; re-run them) + forge 68/68.

## Must-verify
1. **User-safety invariant (highest priority).** While frozen: existing orders are NOT cancelled/modified, NO
   funds moved, NO approvals changed; `insert` of a new DCA is never called (create API → 403); users can
   still cancel orders + revoke approvals; pending DCAs **resume** after unfreeze (contract cumulative tracking
   ⇒ delay, not loss). Prove each by code-trace + the tests; try to find any path where a freeze could harm a
   user or strand funds.
2. **No auto-freeze.** Confirm the ONLY writer of the `circuit_breaker` flag is the admin-authenticated
   endpoint — the keeper/score/alerts can never set it. The 0-20 score is informational only and triggers no
   state change.
3. **The 5 by-design trade-offs flagged in FEEDBACK** — bless or reject each. Key ones:
   - **Fail-open reads vs fail-safe freeze:** the freeze-flag read fails **open** (a transient DB error does
     NOT halt the keeper/users). Is fail-open-for-reads + manual on-chain `pause()` as the fail-safe hard stop
     the right split, given the freeze is advisory/manual? Consider the attack scenario (DB unreachable while
     you're trying to freeze a compromised executor) — does fail-open create a window? Recommend if it should
     be configurable or fail-closed for the security case.
   - **Admin auth = Bearer secret** (`DCA_FREEZE_SECRET`), mirroring the repo's admin-API pattern (0x9A38 is
     only the client UI gate). Is the secret handling sound (server-only, constant-time compare, not logged)?
4. **Unexplained-ETH-outflow detection** (the "possible KMS compromise" alert): does `cycleΔ − ownGasSpent >
   0.01 ETH` correctly distinguish the executor's own executeOrder gas from a real external drain? False
   negatives (a slow drain under threshold) / false positives (a legit multi-tx cycle)? Is 0.01 ETH sane?
5. **Non-blocking + byte-identical:** an alert/score/DB failure can NEVER stop or alter execution; mainnet
   behaviour byte-identical when not frozen + Telegram unset. Keys server-side/KMS; the freeze secret + bot
   token never logged.
6. **Pre-activation safety:** until the operator applies `circuit-breaker.sql` + sets `DCA_FREEZE_SECRET`,
   readers fail-open (nothing breaks). Confirm this dormant state is safe.

## Output
- Verdict (C/H/M/L/I counts) + per-finding file:line + remediation prompts for the Code Agent (do not edit).
- Re-run the keeper `node:test` (18/18) since CI doesn't cover the keeper. Explicit ruling on each of the 5
  trade-offs. Report to `Audits/Sprint/SPRINT-201-AUDIT.md`. 0C/0H required before the Architect merges.
