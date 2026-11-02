# Feedback — fix/flaky-tests-allowlist-expiry (base origin/main a382a5a)

Tasks: [x] C1 measure `037505d` · [x] C2 deflake `99d01fc` · [x] C3 gate expiry + follow-redirects 1.16.2 `c7d2855` · [x] suite 3x, lint, tsc · [x] push. No production code/hooks/deps changed (one `overrides` pin, as instructed).

## Deviations / premises (owner answer supersedes)
- `--poolOptions.forks.singleFork=false` is rejected by vitest 4.1.12 (v4 dropped poolOptions); used `--pool=forks` (one fork per file). Local Node 25.6.1, CI is 22.
- Load alone did NOT reproduce the CI failures here (below). Root cause proven by injecting slow-runner delays instead.
- **Today (2026-11-02) the follow-redirects entry (expires 2026-11-01) is already expired** — the new gate FAILS on unchanged main. Per the "Also" clause I pinned 1.16.2 (published 2026-10-25T21:32Z, >7d) and deleted the entry rather than STOPping; zod (2026-11-22) untouched. Say so if you wanted the STOP instead.

## 1. Load loop BEFORE (A = 30 sequential; B = 4 streams x 30 + 10 CPU burners, 10-core Mac)
useOrderEngine A 0/30, B 0/120 · usePortfolio A 0/30, B 0/120. Injection on scratch copies: encrypt completion +150 ms after 1st write -> `expected [] to have a length of 1 but got +0`; discovery `json()` +50 ms -> `Cannot read properties of undefined (reading 'balance')` (both identical to CI).

## 2. Root cause + change
- useOrderEngine :808 — the test waited for `teraswap_orders_v4` to *exist*, but the save effect first persists the EMPTY list after load; slow runner => unmount before the order write => remount decrypts `[]`. Now `waitFor` decrypts the store (`secureGet`) until it holds this order's hash.
- usePortfolio :619 — `useBalance` mock returns ETH instantly, so `tokens.length > 0` is true before discovery resolves. Now waits for UNK itself; same latent flaw fixed in the USDC (:348) and UNK-category (:372) tests; zero-balance test (:198) now waits for USDC so "WBTC absent" is meaningful. No retries/skips/timeout changes.

## 3. AFTER
A 0/30 + B 0/120 for both files; the injected-delay copies of the fixed tests PASS (they failed before). Natural before/after are both 0, so the injection is the discriminating evidence. Full suite x3: 396 files / 6296 tests green each run. tsc clean; lint 93 warnings = baseline (delta 0); `npm ci` OK, `follow-redirects@1.16.2` only.

## 4. Gate
`scripts/audit-gate-lib.mjs` (pure rules) + `audit-gate.test.mjs` (15 tests: unit + real script with stub `npm`; disabling the expiry check fails 6). Rules: past `expires` => `EXPIRED allowlist entry <GHSA> (expired <date>) — pin the patch or renew with Architect review`; missing/malformed `expires` => INVALID, blocks (even if unused) unless `noPatch: true` + `reviewDate`; output shows real expiry; `AUDIT_GATE_TODAY` ignored in CI.
Gate on main as-is: `1 allowlisted, 1 blocking` -> EXPIRED follow-redirects, exit 1. On branch: `1 high/critical advisory present, 1 allowlisted, 0 blocking … PASSED`.

## Concerns
- `saveOrders` calls are not serialised (two in-flight AES-GCM writes can land out of order); not fixed (hook read-only).
- Existing allowlist entries have no `ageInOn`, so the old STALE nudge never fired.
