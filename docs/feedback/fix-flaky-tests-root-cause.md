# Feedback — fix/flaky-tests-root-cause

Five flaky tests: cause found and fixed in each; recipe red on origin/main 4a4129ef, same recipe green after. No retry, skip,
timeout, sleep or loosened assertion added; one 20 s budget removed; no product code; CI untouched. Long output, rig, ruled-out
hypotheses: [`fix-flaky-tests-root-cause.evidence.md`](fix-flaky-tests-root-cause.evidence.md).

**Owner answers (asked once, 2026-11-17; they supersede the goal text):** test 5 is the two vitest files, 200 runs, drop the 20 s
beforeAll · test 4 on the animation clock, tolerance unchanged · test 3 one command per `it` (+ the 8-start `it`s the recipe turns
red) · keep the same fix in `alert-inflight.test.ts`.

## 1. Per test (before = origin/main; after = branch, same recipe)
| # | recipe | before | cause (origin/main) | fix | after |
|---|---|---|---|---|---|
| 1 | Node 22, native load of `next/server` +d ms (loader hook) | d=15 16/20, d=40 19/20, d=300 20/20 red (CI signature) | `alert-inflight.ts:27-38` loads `after` lazily; the mock factory loads real next/server (~15 ms) and the first alert comes ~6 ms later, so `handToAfter` defers the hand-over past the asserts | wait for the hook by an event (a probe reaches this file's mock); ordering block, 3 sites × 2 orders; same in `alert-inflight.test.ts` (20/20 red before) | d=300 + 40 busy loops 0/200; d=15 + 20 loops 0/200 |
| 2 | bursts of 60 busy loops (2-5 s on/off) | Node 20 5/30, Node 22 1/10 red | `chain-verify.test.mjs:754-783`: wall-clock minima, small batches first and 1/10 as long; load that starts after them inflates only the large side | interleaved, equal work per batch, process CPU time; same rows, statistic, bound | Node 20 0/200, Node 22 0/50 |
| 3 | every spawned node +700 ms at start | 5/5 runs red (7 `it`s: "timed out in 5000ms") | `agent-hooks.test.mjs:110-115` runs 14 process starts in one `it`; `:79-84`, `:93-98` 8 each | one hookExit per `it` | 200/200 green |
| 4 | renderer CPU throttle ×20 (CDP) | 10/10 red (208-364 ms vs 120) | `intro.pw.ts:28-37` clocks from the first frame that sees the overlay via `performance.now()`; animations stay pending ~3 frames, callbacks lag | `t` = frame timestamp − curtain animation `startTime` | 30/30 green (33-100 ms) |
| 5 | every native node_modules load +80 ms | 5/5 red (swap 6 timeouts; shell "Hook timed out in 20000ms") | each file's first `freshPage()` is the cold load of the tree, billed to test 1 (swap) or a 20 s beforeAll (shell `:96-99`) | static import of the same tree (collection, untimed); 20 s beforeAll removed | 200/200 green |

Test 2 took two fixes: interleaving alone 20/20 red; + equal work on the wall clock still 5/200 red under bursts; CPU time 0.
Test 1's first wait (`vi.dynamicImportSettled`) left a 2/40 gap under load; replaced. Mutants for test 1: evidence §1.

## 2. Tests deleted — none.
## 3. Product defect — none. Production cannot skip test 1's hand-over: Turbopack compiles the lazy import to `Promise.resolve().then(() => require(...))` (own build of 4a4129ef), and even the late path runs inside the request's AsyncLocalStorage scope (Node 20/22/26).
## 4. Retries / skips already in the repo (list only)
Skips: `e2e/third-party-hosts/bundle.pw.ts:24`, `scripts/grok-guard.test.mjs:65`, `src/ui/v2/__tests__/mobile/mobile.pw.ts:183`.
Retries: `playwright.config.ts:21`, `playwright.mobile.config.ts:18` (`process.env.CI ? 1 : 0`). Workflows: `continue-on-error: true`
at `dependabot-auto-merge.yml:61`, `security-audit.yml:44`.

## 5. Verify (code head 85d715ad; the branch head adds only this file)
`scripts/agent-verify.sh --keeper --codeql` (Node 22 first on PATH, a `brew` stub first so it never calls Homebrew): suite PASS
10875/0 in 507 files · lint-delta +0/+0 · tsc 0 · build ok · v1v2-parity 123/0 · rpc-budget 36/0 · codeql 13 → 13, 0 new ·
keeper Node 20 1563/0/0, Node 22 1563/0/0 · RESULT PASS. `node scripts/gen-claude-state.mjs --check`: current. gitleaks over the
branch commits: no leaks. diff --stat: 9 files, +346 −42 (7 test files, 2 feedback docs). The only file under `contracts/` is
test 2's own keeper test (the goal's target); no `.sol`, `executor.js`, `basket-*`, `src/app/api/orders/**`, workflow or dep.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/flaky-tests-root-cause (no PR).

**Not verified:** every recipe ran on this Mac only, not on a Linux CI runner (`process.cpuUsage` resolution there not measured);
E2E on cached Chromium 1248 (Playwright 1.65 wants 1254, not installed), only the intro spec of the v2-mobile-parity job (the
job's DCA specs need the repo variables); CI not watched; branch not rebased on main 02487c98 (`git merge-tree` clean; main only
added a vitest include glob); test 3's untouched 4-start `it`s pass at 700 ms (3.2 s) but would time out from ~1.2 s per start.
