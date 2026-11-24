# fix/script-stdout-truncated-on-exit — feedback

Owner answer (asked once, supersedes the goal): the grep found 34 files with a stdout write + `process.exit` (~100 sites), not a handful.
Owner chose: fix what can pass a 64 KB pipe; the guard flags any other file unless allowlisted with a written reason.

## 1. Reproduction (macOS, Node v26.13.1; Linux NOT run)
Command (the committed test IS the repro; the reader starts only after the script's last stderr line, no sleep, no load):
`git show origin/main:scripts/orders/check-order-hashes.ts > scripts/orders/check-order-hashes.ts && npx vitest run scripts/orders/check-order-hashes.pipe.test.ts`
- origin/main: `expected 643 to be 4269` lines; ad hoc run, 4,000 rows: 131,062 B (2nd run 131,470) of 876,747 B, every delivered line valid JSON.
- branch: 876,747 B, 4,269 lines. "macOS writes are synchronous" was wrong: it reproduces here (pipe + reader buffer ≈ 128 KB).

## 2. Scripts with the pattern (34 files)
- **Fixed, repro fails on main**: `orders/check-order-hashes.ts` (:51,:80) · `check-product-claims.mjs:159` (65,536 of 575,087 B of stderr; both
  streams held until `signal-after-main.mjs` reports the module finished) · keeper `list-missing-fills.mjs` (8 sites; table 131,514 B).
- **Fixed, NO truncation repro, by construction**: `dca-feeds/plan.ts` (:22,:64; output = ≤28 enabled rows of the in-repo config ≈ tens of KB, and needs a
  live RPC) · `check-color-contrast.mjs:430` (prints 807 B whatever the input) · `backfill-execution.mjs` (15 sites; ~a dozen lines, only refusal
  texts/codes tested). Preventive; the guard is their test.
- **Exempt**: `executor.js` (daemon, out of scope), `exit-drained.js` (the fix). **Allowlisted, 25 files**, each with a reason in the guard
  (fixed text or in-repo list; read from the code, not measured). Guard = file-level text rule: stdout write AND `process.exit`, comment lines dropped.

## 3. Tests and mutation proof
`check-order-hashes.pipe.test.ts`, `check-product-claims.pipe.test.mjs`, `exit-drained.test.mjs` (helper, list-missing-fills vs a local RPC+Supabase stub,
refusals of both CLIs), `script-stdout-exit-guard.test.mjs`. Existing property test (:317-346) and exit-code tests unchanged and green.
Mutants (scratch copies, `process.exit` restored): check-order-hashes, product-claims, list-missing-fills, exit-drained → a behavioral test fails; plan,
color-contrast, backfill → only the guard fails.

## 4. Verify: `scripts/agent-verify.sh --keeper --codeql`, three runs (all load1 < 10)
1. 33e7cae7 FAIL: tsc + build, one TS2578 (unused `@ts-expect-error` in my test). 2. 93f2750c PASS (11,621 tests). 3. **ca6da82a PASS** = last CODE commit:
suite 11,622/0 fail, lint +0/+0, tsc 0, build ok, parity 123, rpc-budget 36, codeql 11/11 new 0, keeper node20+22 2531. This file = docs-only commit on top.
`origin/main...ca6da82a`: 15 files, +649 −59. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/script-stdout-truncated-on-exit
NOT verified: **Linux CI** (the PR #720 failure itself), `plan.ts` against a live RPC, `backfill-execution` against a live chain/DB, the 25 allowlisted scripts beyond reading them.
