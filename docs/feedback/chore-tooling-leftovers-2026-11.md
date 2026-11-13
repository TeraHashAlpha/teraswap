# Feedback — chore/tooling-leftovers-2026-11

Base origin/main 649105f. No PR (owner opens it). C1–C3 and verify done; this file is the last edit of the branch.

## 1. State block (C1)
- Premise partly false: AGENTS.md has NO state block, only the `claude-md-sha256` pin of CLAUDE.md. Took the conservative reading:
  regenerate CLAUDE.md, re-pin AGENTS.md. The pin still moves when CLAUDE.md changes for any reason, no longer on test-adding PRs.
- Before: `**Test files:** vitest 493 (...include globs...) · keeper node:test 52 · Foundry 3`
- After: `**Test suites** (no counts here ...): vitest, npx vitest run, config vitest.config.ts · keeper node:test, node --test in
  contracts/order-engine/executor/ · Foundry, forge test, configs contracts/foundry.toml, contracts/order-engine/foundry.toml`
- Counts: `node scripts/gen-claude-state.mjs --counts` (stdout only; today vitest 493 · keeper 52 · Foundry 3).
- Tests: "adding a test file of any kind does NOT change the block" (5 files, --check 0, --print identical); "changing something
  the block still states does" (new foundry.toml, moved keeper dir, no vitest config); `--counts` prints and touches nothing.

## 2. goal-lint (C2)
- PASS already: /dev/stdin, CRLF, lone CR, leading blank lines, NBSP-only first line. FAIL `control-line` (reproduced through the
  CLI): BOM, NBSP/zero-width/leading spaces before CONTROL, bracketed-paste ESC markers, `> ` quote, opening fence, `/goal ` prefix.
  `-` as stdin is rc 2 (usage), unchanged.
- The 2026-11-12 FAILs in docs/feedback (stabilise-slow-tests, portfolio-tokens-view, privacy) were goals with NO `CONTROL:` header,
  a true FAIL. Asked once; owner: tolerate "invisible + paste decoration". Fix: `firstControlCandidate()`, CONTROL/READ-ONLY check
  only. `**CONTROL:**`, `# CONTROL:`, a late header and no header still FAIL; length is BYTES of the raw input.
- Tests: 17 new cases red on old code, 55/55 green on the fix.

## 3. Telegram retry (C3)
- One attempt, 5000 ms confirmed. Retry only inside `sendTelegramAlert`: timeout / network / 5xx / 429 (retry_after honoured, capped
  2000 ms), never other 4xx; one warn line per retry. Wrapper, cooldowns, text, other channels untouched.
- Worst case, all hung: 5000 + 500 + 5000 = 10 500 ms; 429 at the cap then hang: 7000 ms; ceiling `TELEGRAM_TOTAL_BUDGET_MS` 12 000 ms
  (attempt 2's timeout shrinks to what is left). Route `maxDuration` 30 000 ms (`tick/route.ts:19`); channels run in parallel.
- Duplicates CANNOT be excluded: if attempt 1 reached Telegram and only the response was lost, attempt 2 posts again (no idempotency
  key on sendMessage). A rare duplicate is accepted over a lost alert.
- Token scrubbed from retry line, final error (no `cause`) and HTTP body; logs via `forLog`; text escaped once, same body re-sent.
- Tests (`telegram-retry.test.ts`, 26): timeout→success = 2 sends + 1 line; network/5xx/429; 400/401/403/404/409 no retry; two
  failures = one "delivery failed" line through the real wrapper; bounds; token never printed; email/Discord sent before the pause
  ends. Mutations (retry-all, no scrub, no clamp, no cap) each turn it red.
- Concern, not fixed (out of scope): `source-state-machine.ts:274,303,351` call `emitTransitionAlert` WITHOUT await, so the function
  may freeze after the tick response before a slow alert finishes. If the 3 lost alerts came from that, the retry shrinks but does
  not remove the loss; awaiting or `waitUntil` there needs its own goal.

## 4. Verify
- `agent-verify.sh --codeql` @ d18b411: suite 10653/0 (494 files), lint +0/+0, tsc 0, build ok, v1v2-parity 111/0, rpc-budget 36/0,
  CodeQL 13→13 (0 new) → RESULT PASS. First run failed v1v2-parity on 2 timeouts in `sounds-parity.swap.test.tsx` (5 s cold-start
  flake already noted in fix-stabilise-slow-tests); alone 3/3 green, rerun green. `gen-claude-state.mjs --check` current, parity OK.
- diff --stat origin/main...d18b411: 9 files, +628 −22 (this feedback commit adds only this file). Keeper suite not run (no keeper code).
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/tooling-leftovers-2026-11
