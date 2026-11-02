# Feedback — fix/flaky-tests-allowlist-expiry

Goal: deflake `useOrderEngine.test.ts:808` + `usePortfolio.test.ts:619`; make `scripts/audit-gate.mjs` enforce allowlist `expires`; bump follow-redirects override to 1.16.2 and drop its allowlist entry. No production code / hooks / deps changed (besides the one override pin).

## Tasks
- [x] C1 measure (this commit)
- [ ] C2 deflake both tests, re-run load loop
- [ ] C3 audit-gate `expires` enforcement + tests; follow-redirects 1.16.2 pin + entry removal
- [ ] Full suite 3x, lint delta, tsc; push + compare link

## Deviations from the goal text (owner answer supersedes)
- `--poolOptions.forks.singleFork=false` is rejected by vitest 4.1.12 (`Unknown option --poolOptions`; v4 removed poolOptions). Used `--pool=forks` (one fork per file = what singleFork=false meant).
- Local Node is 25.6.1; CI is Node 22 (no local 22 available).
- Today is 2026-11-02, so the follow-redirects entry (expires 2026-11-01) is ALREADY expired. Resolved by the goal's own "Also" clause (patch aged in 2026-11-01T21:32Z -> bump pin + delete entry), not by renewing. zod (2026-11-22) is untouched.

## 1. Load loop BEFORE (origin/main a382a5a)
Runs: A = 30 sequential; B = 4 parallel streams x 30 runs with 10 CPU burners (10-core Mac). Naturally: **0 failures** (A 0/30, B 0/120 per file) — the CI failure does NOT reproduce by load alone here.
Deterministic reproduction (scratch copies, not committed) by modelling a slow runner:
- useOrderEngine: delay `crypto.subtle.encrypt` completion by 150 ms after the first write -> `expected [] to have a length of 1 but got +0` (identical to CI).
- usePortfolio: delay the discovery `json()` by 50 ms -> `Cannot read properties of undefined (reading 'balance')` at :619 (identical to CI).

## 2. Root cause (confirmed by the injection above)
- useOrderEngine :808: test 1 waits for `localStorage['teraswap_orders_v4'] != null`, but the hook's save effect first persists the EMPTY list (right after load) and only later the order. The wait passes on the empty-list write, the hook unmounts, and the 2nd mount decrypts `[]` and never recovers. Wrong condition, not a short timeout.
- usePortfolio :619: `useBalance` mock returns 2 ETH instantly, so `tokens.length > 0` is true on first render (ETH only) before discovery resolves; `find(UNK)` races the fetch-mock promise chain. Wrong condition.
