# Feedback — fix/flaky-tests-root-cause

Goal: root-cause five flaky tests; fail on demand before the fix, same recipe green after (>= 200 unit / 30 E2E runs).
No retries, skips, timeouts, sleeps. Long output: `docs/feedback/fix-flaky-tests-root-cause.evidence.md`.

## Checklist
- [ ] 1. `src/lib/source-state-machine.alert-handoff.test.ts` (afterMock 0 calls in CI)
- [ ] 2. `contracts/order-engine/executor/chain-verify.test.mjs:753-790` (timing ratio under load)
- [ ] 3. agent-hooks test with a 5 s limit
- [ ] 4. E2E `v2-mobile-parity`
- [ ] 5. E2E `sounds-parity`
- [ ] Verify: `scripts/agent-verify.sh --keeper --codeql`, `gen-claude-state --check`, keeper on Node 20 + 22
- [ ] Push, compare link
