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

## 5. goal-lint stdin on Linux (C4, after the PR's CI run)
- CI `full-suite` (Linux, Node 22) failed 2 tests of `scripts/goal-lint.test.mjs`, "through the CLI (file and stdin)". Reproduced in a
  `node:22-slim` container (Node 22.23.5, vitest 4.1.12): 53 passed, 2 failed, at `:248` (stdout `''` instead of `OK 140 bytes`, the
  status line `:249` is never reached) and `:253` (status 2 instead of 1). stderr: `goal-lint: cannot read /dev/stdin: ENXIO`.
- Cause: `readFileSync('/dev/stdin')` opens the PATH. On Linux that is a link to `/proc/self/fd/0`, and a Node parent hands its child
  a socket as stdin (measured: `/proc/self/fd/0 -> socket:[...]`), which cannot be opened by path (ENXIO). macOS duplicates the
  descriptor instead, so §2's "PASS already: /dev/stdin" was true on the Mac only. Assumption that turned out wrong.
- Fix: for `-` and `/dev/stdin`, `readFileSync(0)`. Any other argument is still opened as a path; every read error is still rc 2.
  Behaviour change asked by the owner: `-` now means stdin (§2 recorded it as rc 2).
- Tests: the two failing tests are untouched. Two added: `-` gives the same status, stdout and stderr as `/dev/stdin` (0 and 1); a
  directory as stdin is rc 2 `EISDIR` for both spellings, and a directory PATH is rc 2 too. Linux Node 22: old code + old tests 2
  failed; new code + old tests 55/55; new code + new tests 57/57; old code + new tests 4 failed. macOS Node 25: 57/57.
- Edge, not handled: a stdin left non-blocking by its opener with no data ready yet would read as `EAGAIN` and exit 2. Not reached by a
  shell pipe, a redirect, a heredoc or a Node parent (all measured: large input, a writer pausing 400 ms, empty stdin).

## 6. Verify (C4)
- `agent-verify.sh` on this commit's code (§5 and §6 of this file were written after the run), 2026-11-13 22:05 UTC, base origin/main
  130f2dd: lint +0/+0, tsc 0, build ok, v1v2-parity 111/0, rpc-budget 36/0, suite 10653 passed / 2 FAILED (494 files) → RESULT FAIL.
  Both failures are in `src/ui/v2/fiat/fiat.test.tsx` (`:188`, `:285`), not in this branch's diff. After the feedback edit: the 7
  test files that read `docs/feedback` or goal-lint 3098/0, `gen-claude-state.mjs --check` current, eslint 0 on the two changed files.
- Concern, not fixed here (not this goal): those two tests read the real clock. They build a round 89 000 s old and judge it 2 000 s
  later, expecting "unavailable"; inside the FX-closed window `isEurRateFresh` (`src/lib/eur-usd-feed.ts:97-103`) accepts the last
  round before the close, so the answer is "ok". Measured with the clock pinned on this weekend: they fail on a run that starts between
  Friday 21:43:20 UTC and Monday 00:26:40 UTC, and pass outside it. Same 2 failures on the untouched main checkout (7e566fd) at 22:09 UTC.
  CI `full-suite` will be red on them for any run in that window, on any branch. Fix needs its own goal: pin a weekday with
  `vi.setSystemTime` in those two tests, as `:261` and `:269` of the same file already do.

## 7. Fiat on a weekend: what the product does (owner question 2026-11-14, answered before any pinning)
- Euros stay ON through the FX-closed window: Friday's last round is accepted as fresh, the euro option is not disabled.
- Code: one rule, `isEurRateFresh` (`src/lib/eur-usd-feed.ts:97-103`), read by the route (`route.ts:69`: 200 or 503), by the browser at
  load (`eur-rate.ts:68`) and on the minute tick (`eur-rate.ts:85`). A round inside the 25 h ceiling is always fresh. Friday 22:00 UTC to
  Monday 01:00 UTC the last round before the close is fresh too, if it was inside the ceiling AT the close. A feed already stale at the
  close stays stale all weekend; Monday 01:00 UTC with no new round: dollars, option disabled.
- Measured, production, Saturday 2026-11-14 13:54 UTC: `GET /api/fiat/eur-usd?chainId=1` → 200, rate 1.1031, updatedAt 1794584771
  (Friday 2026-11-13 15:46:11 UTC), maxStaleness 90000. The same round as the chain's latest at that minute.
- Measured, chain (60 rounds of the mainnet feed of `src/config/eur-usd-feed.json`, public RPC, read-only): the feed posts its 24 h
  heartbeat on weekends. Last weekend: Fri 2026-11-06 15:00:47, Sat 15:00:59, Sun 15:01:11, Mon 06:07:35 UTC; longest gap 24.00 h. So
  a real round stays under the 25 h ceiling all weekend, and the closed-window rule only decides when a weekend heartbeat is more
  than 1 h late. At the production read the round was 22.13 h old: answered by the plain ceiling, not by the weekend rule.
- Not measured: production at a moment when the round is older than 25 h (it needs a late heartbeat). That case rests on the unit
  tests of the rule (`src/lib/eur-usd-feed.test.ts:49-68`, pinned clocks).

## 8. Fiat clock pins (C5, owner decision 2026-11-14: a second commit on this branch, test files only)
- Edge case not covered by the request: asked to pin the two tests of §6; a sweep with the wall clock shifted (a temporary vitest
  setup file, not committed) found THREE MORE of the same kind. They feed a round `now - 200 000 s` old and expect it refused; from
  the code the weekend rule accepts it from Sunday 04:33:20 UTC (30 h 33 min after the close) to Monday 01:00 UTC. Measured: green
  Saturday 12:00, red Sunday 12:00 and Monday 00:40. They are `fiat.test.tsx` "STALE → dollars", `currency-switch.test.tsx` "a STALE
  rate is the same" and `route.test.ts` "stale round → 503". All five now pin Wednesday 2026-11-11 12:00 UTC and no assertion changed.
  The three extra pins go beyond the two asked: without them CI turns red again on Sunday. The owner can drop them.
- One test added, Saturday clock: `fiat.test.tsx` "SATURDAY NIGHT, Friday's round already PAST the 25 h ceiling". Saturday 23:30 UTC,
  round of Friday 20:00 (27.5 h old): euros shown, option available; still euros when re-judged Sunday 12:00, Sunday 22:30 and Monday
  00:59:59 UTC; dollars and option disabled at Monday 01:00:00 UTC.
- Mutation (local, reverted; `git diff` of the product file is empty): closed-market rule removed from `isEurRateFresh` → the new test
  and 3 tests of `src/lib/eur-usd-feed.test.ts` red. Test gap found: the older hook, switch and route "Saturday" cases stay green under
  that mutation, because their round is 16 h old, inside the plain ceiling. Before this commit only the unit tests exercised the rule.
- Sweep after the pins: the 9 fiat test files 76/0 on the real clock (Saturday 13:58 UTC) and shifted to Fri 12:00, Fri 21:50, Sat
  12:00, Sun 12:00, Mon 00:40, Mon 00:59, Wed 12:00; the whole suite 10656/0 (494 files) shifted to Sun 12:00 and to Mon 00:50. The
  same sweep before the pins: 2 red on Saturday, 5 on Sunday, 3 at Monday 00:40, 0 on Friday noon and Wednesday.
- Product code: not touched.
- Concern for the owner: until this merges, CI on `main` and on every other branch is red on these tests for any run between Friday
  21:43 UTC and Monday 01:00 UTC (two of them from Friday, three more from Sunday 04:33 UTC).

## 9. Verify (C5)
- `agent-verify.sh` on this commit's code (§8 and §9 written after the run), Saturday 2026-11-14 14:03 UTC, inside the FX-closed
  window, base origin/main 130f2dd: suite 10656/0 (494 files), lint +0/+0 (9 changed files), tsc 0, build ok, v1v2-parity 111/0,
  rpc-budget 36/0 → RESULT PASS. CodeQL and keeper not requested (no keeper code, test-only and one CLI read changed).
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/tooling-leftovers-2026-11
