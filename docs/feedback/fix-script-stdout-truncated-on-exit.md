# fix/script-stdout-truncated-on-exit — feedback

Owner answer (asked once, supersedes the goal): the grep found 34 files with a stdout write + `process.exit` (~100 sites), not a handful. Owner chose:
fix what can pass a 64 KB pipe; the guard flags any other file unless allowlisted with a written reason. Followed for every script named.

## 1. Reproduction (macOS, Node v26.13.1; Linux NOT run)
`git show origin/main:scripts/orders/check-order-hashes.ts > scripts/orders/check-order-hashes.ts && npx vitest run scripts/orders/check-order-hashes.pipe.test.ts`
- origin/main: `expected 643 to be 4269` lines (ad hoc 4,000 rows: 131,062 B of 876,747 B, every delivered line valid JSON). Branch: 876,747 B, 4,269 lines.
- The reader starts only at the script's last stderr line, its exit decision, or the end of module evaluation: no sleep, no load. "macOS pipe writes are synchronous" was wrong.

## 2. Scripts with the pattern (34 files); every FIXED one has a repro that fails on main
- **Fixed (what the reader got on main)**: `check-order-hashes.ts` 643 of 4,269 lines · `check-product-claims.mjs` 65,536 of 575,087 B (stderr) · `audit-gate.mjs`
  952 of 3,000 advisory blocks (stderr; fake `npm` on PATH) · `dca-feeds/plan.ts` JSON cut, not parseable (in-process RPC stub, 572 KB) · keeper `list-missing-fills.mjs`
  131,514 B · keeper `backfill-execution.mjs` 131,055 B (stub RPC refuses ranges: 1,000 retry lines). Keeper CLIs via `exit-drained.js`: same text, same codes.
  `check-color-contrast.mjs` too: its report is a fixed 807 B (strict 6-digit hex only), so a REAL pipe never fills and no real-pipe test can fail on main. Its repro
  is a SIMULATION (`lib/async-stdio.mjs`: stdout queued, flushed on the next loop turn): origin/main delivers an empty report, the branch the whole report, same exit code.
- **Allowlisted, not fixed, 24 files** (each with a written reason in `ALLOWED` of the guard; read, not run; sites: `git grep -n 'process\.exit(' -- scripts`):
  capture-endpoint-baseline, check-agents-parity, check-bash3-compat, check-circular, check-deployed-sources, dca-feeds/{batch,build-config,candidates,verify},
  fiat/build-eur-usd-feed, gen-claude-state, generate-arbitrum-catalog, goal-lint, og-image/build, setup-telegram-webhook, sync-readme-deployments,
  sync-token-categories, token-catalog/{refresh-issue,report-diff}, verify-{arbitrum-addresses,arbitrum-chainlink-feeds,base-cbeth-feeds,curve-pool-types,deployed-sources}.
- Exempt: `executor.js`, `exit-drained.js`. Guard = file-level text rule (stdout write AND `process.exit`, comment lines dropped); stale or reason-less entries fail it.

## 3. Tests and mutation proof
`check-order-hashes.pipe.test.ts`, `check-product-claims.pipe.test.mjs`, `audit-gate.pipe.test.mjs`, `dca-feeds/plan.pipe.test.ts`, `check-color-contrast.pipe.test.mjs` (simulated), `exit-drained.test.mjs`
(helper; list-missing-fills and backfill vs stubs; refusal texts), `script-stdout-exit-guard.test.mjs`. Property test (:317-346) and exit-code tests unchanged, green;
audit-gate's 15 existing tests green. Mutation = `process.exit` restored: scratch-copy mutants for order-hashes, claims, list-missing-fills, helper (behavioral test fails);
for audit-gate, plan, backfill, contrast the unfixed run is the origin/main file itself (the numbers above); all are also caught by the guard.

## 4. Verify: `scripts/agent-verify.sh --keeper --codeql`, six runs (all load1 < 10)
1. 33e7cae7 FAIL (tsc+build, TS2578 in my test). 2. 93f2750c PASS. 3. ca6da82a PASS. 4. 5b5558fb PASS. 5. 8591097d PASS. 6. **239f14f6 PASS** = last CODE commit: suite 11,625/0 fail,
lint +0/+0, tsc 0, build ok, parity 123, rpc-budget 36, codeql 11/11 new 0, keeper node20+22 2532. This file = docs-only commit on top.
`origin/main...239f14f6`: 22 files, +1063 −119. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/script-stdout-truncated-on-exit
NOT verified: **Linux CI** (the PR #720 failure itself), plan.ts against a real RPC (stub only), the 24 allowlisted scripts beyond reading them.
