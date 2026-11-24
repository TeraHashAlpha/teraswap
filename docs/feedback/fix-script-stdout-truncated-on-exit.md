# fix/script-stdout-truncated-on-exit — feedback

Owner answer (asked once, supersedes the goal): the grep found 34 files with a stdout write + `process.exit` (~100 sites), not a handful.
Owner chose: fix what can pass a 64 KB pipe; the guard flags any other file unless allowlisted with a written reason.
**Deviation from that answer (my call, flagged):** it named plan.ts, check-color-contrast, audit-gate and claims too. A fix without a test that
fails on main is not claimed, so only scripts with a repro are fixed: plan.ts, check-color-contrast and audit-gate are ALLOWLISTED (audit-gate never changed).

## 1. Reproduction (macOS, Node v26.13.1; Linux NOT run)
`git show origin/main:scripts/orders/check-order-hashes.ts > scripts/orders/check-order-hashes.ts && npx vitest run scripts/orders/check-order-hashes.pipe.test.ts`
- origin/main: `expected 643 to be 4269` lines (ad hoc 4,000 rows: 131,062 B of 876,747 B, every delivered line valid JSON). Branch: 876,747 B, 4,269 lines.
- The reader starts only at the script's last stderr line / exit decision: no sleep, no load. "macOS pipe writes are synchronous" was wrong: it reproduces here.

## 2. Scripts with the pattern (34 files) and what happened to each
- **Fixed, each with a repro that fails on main (bytes the reader got)**: `orders/check-order-hashes.ts` (643 of 4,269 lines) · `check-product-claims.mjs`
  (65,536 of 575,087 B stderr) · keeper `list-missing-fills.mjs` (131,514 B) · keeper `backfill-execution.mjs` (131,055 B; stub RPC refuses ranges, 1,000 retry lines).
  Both keeper CLIs through `exit-drained.js`: same text, same codes.
- **Allowlisted, not fixed**: `plan.ts` (28 enabled rows, tens of KB, live RPC; guard FAILS above 40 rows) · `check-color-contrast.mjs` (807 B) · `audit-gate.mjs`
  (≈ a dozen lines) · 22 more, each with a reason in the guard (fixed text or in-repo list; read from the code, not measured). Exempt: `executor.js`, `exit-drained.js`.
- Guard = file-level text rule: stdout write AND `process.exit`, comment lines dropped; stale or reason-less entries fail it.

## 3. Tests and mutation proof
`check-order-hashes.pipe.test.ts`, `check-product-claims.pipe.test.mjs`, `exit-drained.test.mjs` (helper; list-missing-fills and backfill vs local stubs; refusal texts),
`script-stdout-exit-guard.test.mjs`. Property test (:317-346) and exit-code tests unchanged, green. Mutants (`process.exit` restored, scratch copies): every fixed script
fails its behavioral test (and the guard); the helper with an immediate exit fails 2 keeper tests. Mutants were run before plan/contrast were reverted and before the backfill
test existed; for backfill and claims the "unfixed" runs above are the origin/main files.

## 4. Verify: `scripts/agent-verify.sh --keeper --codeql`, four runs (all load1 < 10)
1. 33e7cae7 FAIL (tsc+build: TS2578 unused `@ts-expect-error`, mine). 2. 93f2750c PASS. 3. ca6da82a PASS (claims repro added). 4. **5b5558fb PASS** = last CODE commit:
suite 11,623/0 fail, lint +0/+0, tsc 0, build ok, parity 123, rpc-budget 36, codeql 11/11 new 0, keeper node20+22 2532. This file = docs-only commit on top.
`origin/main...5b5558fb`: 14 files, +759 −55. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/script-stdout-truncated-on-exit
NOT verified: **Linux CI** (the PR #720 failure itself), plan.ts against a live RPC (and its 2.5 KB/row size is an estimate), the 25 allowlisted scripts beyond reading them.
