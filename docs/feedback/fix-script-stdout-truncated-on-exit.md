# fix/script-stdout-truncated-on-exit — feedback

Owner answer (asked once, supersedes the goal): grep found 34 files with a stdout write + `process.exit`, not a handful. Owner chose:
fix the scripts whose stdout can pass a 64 KB pipe; the guard flags every other file unless allowlisted with a written reason.

## 1. Reproduction (origin/main e0140edd, Node v26.13.1, macOS; Linux NOT run)
Reader holds stdout back until the child's stderr summary arrives (its last output before the exit decision): no sleep, no load.
4,000 rows: **main 131,062 B / 643 lines** (2nd run 131,470 / 645) of 4,269 expected; **branch 876,747 B / 4,269 lines**, all valid JSON.
The goal's "macOS pipe writes are synchronous, never shows locally" is wrong: it reproduces here (pipe + reader buffer ≈ 128 KB).

## 2. Scripts with the pattern (34 files, ~100 sites)
- **Fixed** `scripts/orders/check-order-hashes.ts` (`exitCode`, was :51/:80) · `scripts/dca-feeds/plan.ts` (:22/:64, one big JSON then exit) ·
  `check-product-claims.mjs:159` · `check-color-contrast.mjs:430` · keeper CLIs `list-missing-fills.mjs` (8 sites) and
  `backfill-execution.mjs` (15 sites) via `exit-drained.js` (`CliExit` + `exitAfterDrain`: same text/codes, still exits promptly).
- **Exempt in code**: `executor.js` (daemon, out of scope by the goal), `exit-drained.js` (the fix).
- **Allowlisted, 25 files, each with a reason in the guard**: output bounded by fixed text or an in-repo list (e.g. `audit-gate`, `verify-*`,
  `dca-feeds/batch|candidates|verify`, `goal-lint`, `report-diff`: capped at 20 per list). Reasons read from the code, not measured.
- Guard: file-level text rule (stdout write AND `process.exit`, comment lines dropped; not ordered, a `say()` helper defined on top is the
  shape that lost output); stale or reason-less entries fail it.

## 3. Tests and mutation proof
- New, fail on main: `check-order-hashes.pipe.test.ts` (643 of 4,269) · `exit-drained.test.mjs` list-missing-fills table (131,514 B, local RPC+Supabase stub).
  Existing property test at :317-346 unchanged and green; exit-code tests green (also code 2 for unreadable input).
- NO truncation repro, by construction: `plan.ts` (public RPCs hardcoded), `check-product-claims`, `check-color-contrast`, `backfill-execution`
  (stdout bounded to ~a dozen lines; only the refusal texts/codes are tested). Their protection is the guard.
- Mutants (scratch copies, `process.exit` restored): check-order-hashes → pipe test + guard fail; list-missing-fills → keeper test + guard
  fail; exit-drained (exit at once) → 2 keeper tests fail; plan, claims, contrast, backfill → guard only fails.

## 4. Verify (`scripts/agent-verify.sh --keeper --codeql`, two runs, both listed)
- Run 1 on 33e7cae7: FAIL: `tsc` 1 error (TS2578 unused `@ts-expect-error` in my pipe test, because the `.d.mts` types the import), `build` same error;
  suite 11621 pass, codeql 0 new, keeper node20/22 2531 pass.
- Run 2 on **93f2750c** (last CODE commit; load1 9.64): **PASS**, all 8 checks: suite 11621/0 fail, lint +0/+0, tsc 0, build ok, parity 123, rpc-budget 36, codeql head 11 / base 11 / new 0, keeper node20+22 2531 pass.
- Docs-only commit on top: this file. `git diff --stat origin/main...93f2750c`: 12 files, +510 −59 (code/tests, plus the feedback file in the final commit).
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/script-stdout-truncated-on-exit
- NOT verified: **Linux CI** (pipe size 64 KB vs macOS growth, the PR #720 failure itself), `plan.ts` against a live RPC, backfill against a live chain/DB,
  the 25 allowlisted scripts beyond reading them. Test timing is event-ordered, not clock-based, but only ran on this Mac.
