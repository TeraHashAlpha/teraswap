# Evidence — fix/flaky-tests-root-cause

Companion to `fix-flaky-tests-root-cause.md` (long output). Machine: owner's Mac (10 cores, Apple Silicon), worktree
`~/ts-worktrees/flaky-tests-root-cause`, base origin/main 4a4129ef. Node 20.20.2 / 22.23.5 from /opt/homebrew/opt/node@20, @22
(CI: 22.23.4 for vitest, 20 + 22 for the keeper). Rig scripts live in the session scratchpad (`rig/`), never committed; each
recipe below names its file and the exact env.

## Test 1 — `src/lib/source-state-machine.alert-handoff.test.ts`

CI 2026-11-17 18:28 UTC, job 134267823031 (run 44147870975, feat/split-dca-coordinator): 5 failed / 1 passed in the file,
`afterMock` 0 calls at :76 :92 :108 :138, `mock.calls[0]` undefined at :121; each test 1-8 ms.

Recipe: `rig/slow-next-server.mjs` (a Node module-customization `load` hook that delays only `node_modules/next/server.js`):
`NODE_OPTIONS="--import rig/slow-next-server.mjs" SLOW_NEXT_SERVER_MS=<d> CI=true npx vitest run <file>` on Node 22.23.5.

Timeline probe on origin/main (stderr writes in alert-inflight.ts, reverted): module init 130.0 ms, `after` loaded 146.2,
first hand-over 152.4: a ~6 ms margin. The CommonJS evaluation of next/server (~120 ms) is synchronous, so once it starts the
hook always wins; the race is decided before it starts (RPC + async load), which is what the hook delays.

Before (origin/main, 20 runs each): d=0 → 0 red; d=15 → 16 red; d=40 → 19 red; d=300 → 20 red; every red = `5 failed | 1 passed`,
the CI signature. `alert-inflight.test.ts` (same race, origin/main copy): d=300 → 20/20 runs red, each `2 failed | 7 passed`
(the two tests that assert a synchronous hand-over); d=0 9/9 pass.

Ruled out: (a) mock already loaded from another file in the same worker — vitest 4.1.12 `isolate: true` (default, not overridden
in vitest.config.ts or ci.yml) stops the fork after each file (`cli-api` pool: runner.stop unless `task.isolate === false`), and
`emit` passed in CI, so the state machine was loaded fresh with this file's mocks. `--no-isolate --maxWorkers=1` with
alert-inflight.test.ts first DOES give the same signature (alert-inflight evaluated once, bound to the other file's mock), but CI
never runs that way. (b) file order — irrelevant with a fresh process per file. (c) pool: forks and threads both pass idle.

First fix attempt (a1cf1570): `await vi.dynamicImportSettled()` in beforeAll. Under 40 busy loops + d=300 it returned before the
hook was loaded in 2 of 40 runs of alert-inflight.test.ts (the new guard caught it): vitest does not track every step of the
mock factory → importActual → native load chain. Replaced (4c479622) by an event-driven wait: hand a probe to trackAlert and wait
for THIS file's mock to receive it.

Mutants against the final tests (`rig/t1-mutants.sh`):
- M1 late path drops the alert (`afterLoaded.then(...)` removed from handToAfter) → 6 ordering tests red
- M2 hook never called (handToAfter returns) → beforeAll red, file red
- M3 the beforeAll wait removed, d=300 → `5 failed | 7 passed`, the CI signature
- M4 shared registry (`--no-isolate`) → beforeAll red ("Hook timed out")

After (both files, Node 22.23.5): d=300 + 40 busy loops (`rig/with-load.sh 40`): 200 runs, 0 red; d=15 + 20 busy loops: 200 runs,
0 red. (An earlier 400-run batch on a1cf1570 had 0 red in the handoff file and 11 + 18 red in alert-inflight.test.ts: the
dynamicImportSettled gap above.)

Production (statement): the hand-over cannot be skipped by this race.
1. This worktree's own `next build` of 4a4129ef (BUILD_ID H7RGNVRuS1L2iK9CU1vCp), chunk `.next/server/chunks/_0998bqs15u84r._.js`:
   `let r=e.A(133299).then(e=>{t=e.after},()=>{});function s(e){t?t(e):r.then(()=>{try{t?.(e)}catch{}})}`; loader 133299 in
   `_01c6ia6pdb_49._.js`: `e.v(e=>Promise.resolve().then(()=>e(89171)))`; chunks load with a synchronous `require`
   (`[turbopack]_runtime.js:796,825`). So `after` is in place a few microtasks after the module evaluates, before any I/O
   completes; every trackAlert site runs after an awaited KV call (loadFromKV / pipeline.exec).
2. Even on the late path the hand-over still happens inside the request: `rig/als-late-path.mjs` (a `.then` registered inside
   `AsyncLocalStorage.run`, on a promise resolved later from outside) sees the request's store on Node 20.20.2, 22.23.5, 26.13.1.
The only skip is the documented one: no request scope at all (script/test) → fire-and-forget. No product change.

## Test 2 — `contracts/order-engine/executor/chain-verify.test.mjs` (linearity ratio)

Mechanism harness `rig/t2-variants.mjs` (same rows and statistic, four schedules, rotated order, Node 20.20.2):
| load avg | A sequential (origin/main) | B interleaved only | C interleaved + equal work | D = C with origin/main's total work |
|---|---|---|---|---|
| ~85 | 19/20 over 30, median 53.4, max 106.0 | 20/20, 71.8, 95.7 | 0/20, 12.6, 15.1 | — |
| ~52 | 6/20, 12.3, 46.6 | 6/20, 11.9, 47.2 | 0/20, 11.9, 15.6 | 0/20, 11.9, 15.9 (2624 vs 2658 ms/round) |
Real test under that load on origin/main: `labels that never reach a TLD: 10x the input took 89.5x (0.5761ms -> 51.5837ms)`.

First fix (794437f0: interleaved + equal work, wall clock), real test A/B (`rig/t2-ab.sh`: origin/main copy and the branch file
alternating, Node 20.20.2) under 40 busy loops plus the bursty proof jobs of tests 4/5 (load average ~90-105): before 29/30 red,
after **5/200 red** (last: `labels that never reach a TLD: 48.8x (0.8510ms -> 41.5120ms)`). Not accepted. Cause of the rest: a
wall clock counts time spent waiting for a core; a burst that starts after a row's first (clean) small batch inflates every large
batch. Short on/off bursts (0.3-1 s, 40 loops) did not discriminate (A 1/60, D 0/60, E 0/60); long bursts did:

`rig/with-long-burst-load.sh 60` (60 `yes` loops, SIGCONT / SIGSTOP together, 2.0-4.9 s per phase), harness, Node 20, 100 rounds:
A origin/main shape 12 over (max 106.8); D interleaved + equal work, wall clock 2 (max 51.3); E the same in process CPU time
(`process.cpuUsage`, user + system) 0 (max 13.8). `process.cpuUsage` resolution measured 1 µs on Node 20.20.2 and 22.23.5
(`rig/cpu-res.mjs`). Second fix (3d582929) = E. The whole chain-verify file: 102/102 on Node 20 and 22.

Final A/B on the real test (`rig/with-long-burst-load.sh 60 bash rig/t2-ab.sh <wt> <pairs> <runs> <node>`; before = origin/main
copy, alternating with the branch file under the same bursts):
- Node 20.20.2: before **5/30 red** (last `a host that never reaches a port: 81.2x`); after 3d582929 **0/200 red**.
- Node 22.23.5: before 1/10 red (`labels that never reach a TLD: 89.0x`); after **0/50 red**.

## Test 3 — `scripts/agent-hooks.test.mjs`

Recorded failure: `docs/feedback/chore-dependabot-alerts-2026-11.md:78`, "A77d H-11 ... stay allowed in the main checkout", 5000 ms
timeout during a whole-suite run. The 5 s is vitest's default testTimeout. Measured at load average 56-75: each `it`'s time is its
process-start count × ~106 ms (14 starts 1491 ms, 8 starts ~880 ms, 2 starts ~210 ms).

Recipe: `rig/slow-node-start.mjs` (every Node process that loads it waits SLOW_NODE_START_MS at start, Atomics.wait, no CPU):
`NODE_OPTIONS="--import rig/slow-node-start.mjs" SLOW_NODE_START_MS=700 CI=true npx vitest run <file> -t "A77d H-11"`, Node 22.

Before (origin/main copy): 5/5 runs red, each `7 failed` "Test timed out in 5000ms": the 14-start test (11.3 s) and the six
8-start "hook cwd = main / linked worktree" tests (6.5 s); 2-start `it`s 1.6 s, 4-start 3.2 s, all green.

After 1ee6fd87 (`rig/par.sh 10 20 … rig/t3-one.sh <wt> scripts/agent-hooks.test.mjs 700`, 10 parallel streams): **200/200 green**
(48 `it`s in the block; each former loop row ~1.6 s at 700 ms). Whole file at no delay: 2015/2015.

## Test 4 — `src/ui/v2/__tests__/mobile/intro.pw.ts` "timeline as built" (job v2-mobile-parity)

CI reds: run 43898295665 (main, 2026-11-16, job 133407732199) and 43867105518 (PR #696, job 133298380651): `intro.pw.ts:192`
`expect(Math.abs(r.appearMs - i * 600)).toBeLessThan(TOL)` Expected < 120, Received 142. Earlier reds (2026-11-11/13) were the
touch specs on feature branches before they were rewritten; not reproduced, out of this goal.

Diagnostic spec (temporary, not committed) at idle: the overlay is in the DOM for 3 frames with its animations `pending`
(`startTime` null); `startTime` 627.1 vs first sampled `performance.now()` 571.3; rAF callback 61 ms after its frame timestamp.
Idle INTRO TIMING with the old sampler: word 0 at 25-52 ms, sweep 2968-2999, last 3317-3349 (a constant offset).
OS load does not move it on this Mac (20-40 `yes` loops: 24-62 ms); background/utility QoS starves Chromium below 100 frames (a
different failure). Recipe: CDP `Emulation.setCPUThrottlingRate` on the page (`rig/t4-throttle-patch.py`, applied to both specs,
never committed): x3 → 55-87 ms, x6 → 90-108, x10 → 175-263 (5/5 red), x14 → 290-339 (5/5 red) on the old sampler.

Proof (`rig/t4-proof.sh`, before = origin/main spec as a temporary copy, both with the throttle patch; machine also under the
test-2 busy loops, load average ~90):
- x10: before 1/10 red (word 0 at 82-156 ms: under that machine load x10 sat just under the bound); after 30/30 green (17-50 ms).
- x20 (the recipe): before 10/10 red, Received 208 212 213 214 215 227 246 253 273 364; after 30/30 green, word 0 at 33-100 ms
  (the remainder is frame spacing at x20, which the unchanged 120 ms tolerance is for).

Local runs use the cached Chromium build 1248 (Chrome for Testing 156.0.8078.4) through the config's `PW_CHROMIUM`; Playwright
1.65.0 wants build 1254, not cached, not installed (no software installs). Server: `next start -p 3917` on this worktree's
`UI_V2_ENABLED=true` production build of 4a4129ef.

## Test 5 — `src/ui/v2/shell/sounds-parity.test.tsx`, `src/ui/v2/swap/sounds-parity.swap.test.tsx`

Recorded reds: chore-tooling-leftovers-2026-11.md:41 (2 timeouts, swap file), docs-agent-context.md:42, feat-ui-v2-design-review-1.md:30,
feat-ui-v2-analytics.md:27, chore-agent-harness.md:24 (shell file, "5 s timeout + state leak"). Not an E2E (owner answer).

Recipe: `rig/slow-modules.mjs` (loader hook: every native load of a file under node_modules waits SLOW_MODULES_MS):
`NODE_OPTIONS="--import rig/slow-modules.mjs" SLOW_MODULES_MS=80 CI=true npx vitest run <shell file> <swap file>`, Node 22.

Before (origin/main copies): 5/5 runs red: 4 × `6 failed | 2 passed | 12 skipped` (shell "Hook timed out in 20000ms" + swap 6 ×
"Test timed out in 5000ms"), 1 × swap only. Under plain machine load (40 busy loops, no recipe) the swap file alone was already
red once (first test 5037 ms, the abandoned import then broke the second test at 1676 ms).

After 61dfc435 (`rig/par.sh 10 20 … rig/t5-one.sh <wt> 80 <shell> <swap>`: 10 parallel streams, so also under their load):
**200/200 green**. One single run at 80 ms: `20 passed`, tests phase 7.0 s, the cold load moved to import/collection (161 s cumulative).
