# Feedback — chore/tooling-leftovers-2026-11

Base: origin/main 649105f. Goal text pasted at 7e566fd; no PR (owner opens it).

- [x] C1 state block without test-file counts
- [x] C2 goal-lint false FAIL on pasted goals
- [x] C3 Telegram single retry
- [ ] Verify (`agent-verify.sh --codeql`, `gen-claude-state.mjs --check`), push, compare link

## 1. State block (C1)
- Premise partly false: AGENTS.md carries NO state block, only the one-line `claude-md-sha256` pin of CLAUDE.md. Conservative
  reading taken: regenerate CLAUDE.md, then re-pin AGENTS.md (`check-agents-parity.mjs --write`). That pin line still changes
  whenever CLAUDE.md changes for any reason; with counts gone that is only a real drift, not every test-adding PR.
- Before: `**Test files:** vitest 493 (the include globs of vitest.config.ts) · keeper node:test 52 · Foundry 3`
- After: `**Test suites** (no counts here ...): vitest, npx vitest run, config vitest.config.ts · keeper node:test, node --test in
  contracts/order-engine/executor/ · Foundry, forge test, configs contracts/foundry.toml, contracts/order-engine/foundry.toml`
- Counts: `node scripts/gen-claude-state.mjs --counts` (stdout only; today `vitest 493 · keeper node:test 52 · Foundry 3`).
- Tests (`scripts/gen-claude-state.test.mjs`): "adding a test file of any kind does NOT change the block" (5 files, --check
  still 0, --print byte-identical); "changing something the block still states does" (new foundry.toml, moved keeper dir,
  missing vitest config → --check fails / fails closed); `--counts` test.

## 2. goal-lint (C2)
- Reproduced (matrix through the real CLI): PASS already = stdin via /dev/stdin, CRLF, lone CR, leading blank lines, NBSP-only
  first line, NBSP after the colon. FAIL `control-line` = a prefix glued to `CONTROL:` on the first line: BOM, NBSP, zero-width
  space, leading spaces/tab, bracketed-paste ESC markers, `> ` quote, opening ``` / ~~~ fence, `/goal ` prefix. `-` as stdin is a usage error (rc 2).
- Premise only partly true: the 2026-11-12 FAILs in docs/feedback (stabilise-slow-tests, portfolio-tokens-view, privacy) were
  goals with NO `CONTROL:` header at all, a genuine FAIL. Asked once; owner: tolerate "invisible + paste decoration".
- Fix: `firstControlCandidate()` drops those prefixes for the CONTROL/READ-ONLY check only. `**CONTROL:**`, `# CONTROL:`, a
  header that is not on the first content line, and no header at all still FAIL. Length is still BYTES of the raw input.
- Tests: 17 new cases red on old code, 55/55 green on the fix (each case via lintGoal; BOM+CRLF+quote and stdin via the CLI).

## 3. Telegram retry (C3)
- Premise held: one attempt, `CHANNEL_FETCH_TIMEOUT_MS = 5000`. Retry lives inside `sendTelegramAlert` only (email/Discord, the
  wrapper, cooldowns, text untouched). Retries timeout / network error / 5xx / 429; never other 4xx. One retry, one warn line.
- Worst case, every attempt hung: 5000 + 500 (default pause) + 5000 = 10 500 ms; 429 asking for the cap: 0 + 2000 + 5000 = 7000 ms;
  hard ceiling `TELEGRAM_TOTAL_BUDGET_MS` = 12 000 ms (attempt 2's timeout shrinks to what is left). Route `maxDuration` = 30 000 ms
  (`tick/route.ts:19`). Channels run in parallel, so the fan-out costs max(channel), not the sum.
- Duplicates: CANNOT be excluded. If attempt 1 reached Telegram and only the response was lost, attempt 2 posts it again
  (`sendMessage` has no idempotency key). A rare duplicate is accepted over a lost alert.
- Token: scrubbed from every message (retry line, final error, HTTP body), final error has no `cause`; logs go through `forLog`.
- Tests (`telegram-retry.test.ts`, 26): timeout→success (2 sends, 1 line); network/5xx/429; 400/401/403/404/409 no retry;
  retry_after honoured + capped; two failures → one "delivery failed" line via the real wrapper; worst-case bounds; token never
  printed; email/Discord sent before the retry pause ends. Mutation-checked (retry-all, no scrub, no clamp, no cap → red).
- Further read / concern (not fixed, out of scope): `source-state-machine.ts:274,303,351` fire `emitTransitionAlert` WITHOUT await,
  so after the tick response the function may be frozen before an alert (now up to 10.5 s) finishes. If the 3 lost alerts came from
  that, the retry shrinks but does not remove the loss; awaiting or `waitUntil` there needs its own goal.
