# fix/quote-split-followups (**Auditor required**: rate limiting and which route Swap executes)

Follow-ups to PR #733 (audit A108: S-1 and the pre-existing list). Base: origin/main `68e817d0`. No limit number changes.

- [x] 1. S-1: no split selected → the refresh is its own request; the route starts the main quote before the charge
- [x] 2. The 429 wait follows `X-RateLimit-Reset`
- [x] 3. A split switched off by hand stays off for that trade
- [x] 4. One percent sign
- [x] Each new test failing on origin/main first · differential · browser v1 and v2 · one verify run · push

## Evidence
**1. Fix 1:** `useSplitRoute.ts:301,317` (a poll carries the split only while one is selected), `route.ts:247-252` (main lookup before the charge). Tests: `route.split.test.ts` +2 (charge held open), cadence +2, `budget.test.tsx` v1+v2: no split selected, ≤ 14 a minute over 3 minutes per action, no 429, and the poll takes 300 ms while sub-quotes take 2.5 s.
**Fix 2:** `useQuote.ts:59,456` (reset + 1 s, cap 120 s), `:288` (timer guard). Tests: +13 hook; real-limiter 60 s window v1+v2. **Fix 3:** `useSplitRoute.ts:331`. Tests: +4 hook; switch v1+v2.
**Fix 4:** `SplitRouteVisualizer.tsx:93`, `SplitRoutePanel.tsx:38`, `SwapBox.tsx:1166`; a syntax-tree search of `src/` for `fmtPct` output followed by "%" found no other. Tests: badge v1+v2, Share label.
**Failing first:** the committed test files over `68e817d0`'s code: 36 fail (all 32 new + 4 changed), the other 90 pass. On the branch all pass.
**CHANGED EXPECTATION:** CADENCE ×3: AN UNSELECTED SPLIT'S REFRESH OR RETRY IS ITS OWN REQUEST, NEVER ON A POLL. SWEEP ×1: v1's SHARE LABEL HAS ONE "%" AND THE "%%" ALLOWANCE IS GONE.
**Differential:** main's `useSplitRoute` vs this one (temporary test), 100 seeded quote sets on each of 1/8453/42161, first analysis + 8 polls: 2,700 steps, 2,226 with a split route, 0 differ. Router, 15 s check, charges and limits: code unchanged.
**2. Requests,** each step 0 action's first minute, $10,000, real route + limiter (jsdom), same on main and branch, v1 = v2, split winning or not: idle 4, 5 tokens 12, typed 10, flip 10, backspace 11, fast retype 6, two tabs 9; no 429. Later minutes, no split selected (browser): 4.0 → 4.7 a minute per tab.
**Swap disabled, no split selected** (Chromium, production builds, real limiter on a fake Upstash, stub upstreams 0.3 s main / 2.5 s sub, stand-in wallet, 3 min, 50 ms samples), main → branch: **v1 2.87 → 1.40 s a minute** (longest 2.55 → 0.35 s); v2 0 → 0. Polls at 65 s and 140 s: 2.5 s → 0.32 s.
**3. Browser,** v1 and v2 alike: badge "+0.14%"; selected: polls carry the split; switched off: still off 155 s later, 2 split requests of its own in 12, polls 317–328 ms; 4 ETH: on again, "+0.16%". Spent bucket: "Retrying in 58s", 10 s later "48s"; one refusal, retry 57.4 / 57.5 s after it (window freed at ≈ 56.3 / 56.5 s) answered 200; 0 page errors.
**4. Verify:** one run, `agent-verify.sh --codeql` on code `1153bc4f`, load 1.91: **PASS** (12329 tests, 0 failed; lint +0 err, +0 warn; tsc, build, v1-css, parity, rpc-budget; CodeQL 11 = 11, 0 new; keeper SKIP). This docs-only commit follows it.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/quote-split-followups
**NOT verified:** production (never called) · real Upstash, upstreams, client-IP headers, wallet or chain · split execution and the stale fallback in a browser (code unchanged) · Share label in a browser · a wrong device clock outside the reasoning below · Base/Arbitrum in a browser · Linux CI.

## For the owner and the Auditor
- **Needed by fix 2, not in the goal** (`useQuote.ts:288`): the poll timer repeats at the current wait. A header wait of 1-2 s
  would abort every slower retry before it answered. While backing off, the timer now leaves a request younger than 15 s
  alone; a hung one is still replaced. Outside a backoff it behaves as before.
- **Needed by fix 1** (`useSplitRoute.ts:208-211`): with the retry now its own request, one that failed after a deferral
  left the wait in the past and would have asked on every later quote. A failure now uses the wait up (60 s rule again).
- **"Absurd" header, my definition:** not a whole number, more than 1 h ahead, or past by 1 s or more. Past by under 1 s
  means the window freed while the answer travelled: retry after the 1 s margin. The doubling counts refusals in a row,
  not header waits.
- **Device clock:** the reset (server epoch ms) is read against the browser's clock. By reasoning, not tested with a skewed
  clock: running behind waits longer (≤ 120 s); running ahead retries early once, then follows the doubling.
- With a split SELECTED the poll still waits for the slowest sub-quote (as the goal allows). Starting the main lookup first
  only removes the charge's wait in front of it.
- I edited two of my own new tests after their first run: "in the past" is now a minute past (see above), and the 60 s
  recovery case checks the card (no "Retrying in", a quote shown) because jsdom keeps v1's earlier toast node. The
  committed versions are the ones in the 36 failures above.
- `docs/feedback/feat-ui-v2-mobile-parity.md` still records the "%%" ruling ("v1 left untouched"). Left as history.

## Further reads (the task needed them)
`src/lib/{split-poll,split-routing-types,format,fetch-json}.ts` (`split-poll.ts`: comment edit), `src/test-utils/fake-kv.ts`,
`src/components/{SwapButton,ToastProvider}.tsx`, `src/ui/v2/primitives/Toggle.tsx`, `e2e/third-party-hosts/cow-flow.ts`,
`.github/workflows/e2e.yml`, `scripts/agent-verify.sh`, `docs/feedback/feat-ui-v2-mobile-parity.md` (one row).
The browser rig reuses the goal 136 and A108 rig scripts (outside the repo), copied into the session scratchpad; it is not
committed. The detached worktree `~/ts-worktrees/quote-followups-main-ref` served as the "before" build.
