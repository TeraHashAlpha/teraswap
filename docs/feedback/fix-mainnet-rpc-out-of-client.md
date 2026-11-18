## Feedback — fix/mainnet-rpc-out-of-client (SEC-5, security audit 2026-11-17)

**Draft + Auditor required** (a provider key reached a client chunk; the server RPC chain changed). Tables T1-T7:
`fix-mainnet-rpc-out-of-client.tables.md`.

### Owner answers (asked once, 2026-11-17; they supersede the goal text)
- **E2E quote**, answered: real `/api/rpc` handler, ABI-aware upstream stub, `/api/quote` fixture, rig committed, local-only config.
- **Guard scope, env checks, fallback names**: no answer the first time; applied the recommended readings, then **confirmed by
  the owner (2026-11-18)**: server-only = `src/app/api/**` + rpc-env.ts `readServerOnly` (L2 deprecated fallback kept
  byte-identical); the required `NEXT_PUBLIC_RPC_URL` rule removed, `RPC_URL_1` stays a warning; `NEXT_PUBLIC_FALLBACK_RPC_1/_2` dropped.
- **Verify red outside the diff** (suite: 5 s timeouts under load, on main too; T7): owner "Push now"; then, for the green
  gate, owner allowed **ONE rerun on a quiet machine** (no other verify/CodeQL, 1-min load < 10): run 3, PASS.

### 1. Step 0 (T1)
Before (`4a4129ef`): marker in `.next/static/chunks/1_7izng880dte.js`, from `registry.ts:42`; CI bundle test FAIL (2 hits).
After (`4fdda809`): 0 hits for every marker in `.next/static`, and in all of `.next`; bundle test PASS.

### 2. How the browser reaches mainnet (T2)
As Base/Arbitrum do: one builder, `wagmiConfig.ts:46-51` → `proxyRpcUrl` (`rpc-proxy-url.ts:21-31`) = same-origin `/api/rpc`
(L2: `?chainId=<id>`); no browser fallback, no new provider. Upstream `serverRpcUrl(1)`: `RPC_URL_1` → `RPC_URL` → llamarpc
(`rpc-env.ts:52`). Hosts contacted, v1 and v2 (T3): our origin only; the marker hosts never.

### 3. RPC calls vs 300 units/min (T4)
Swap screen + wallet, first 30 s: v1 10, v2 9. One quote: v1 6, v2 5. Busiest 60 s: v1 **18**, v2 **16**; 0 refusals, even
under the local 150/min in-memory fallback. Methods sent (5) all on the chain-1 allow-list. Limits/allow-list untouched.

### 4. Tests, mutation proof (T5, T6)
New: `next-public-rpc-reads.guard.test.ts`, `rpc-env.mainnet-server.test.ts` (only RPC_URL_1 / none / legacy / the three names
alone → ignored / RPC_URL_1 wins), `env-validation.rpc.test.ts`, `e2e/mainnet-rpc-session` (local, 2/2). Mainnet cases updated
in 4 files; Base/Arbitrum tests unchanged and green. Mutants: M1 (registry read back) killed by 3 tests, M2 (computed server
fallback) by 5, M3 (alias read) by 4; names in T6.

### 5. Verify, diff, NOT verified, owner steps (T7)
`agent-verify.sh --codeql` run 3 at `32640ef1` (quiet machine, Node 22.23.5, base origin/main `02487c98`): **RESULT: PASS**:
suite 10870 passed / 0 failed (510 files), lint-delta +0/+0, tsc 0, build, v1v2-parity 123/0, rpc-budget 36/0, CodeQL 13 → 13
(0 new). Runs 1-2 (under load avg ~64) were red on 5 s timeouts only; my own run-1 red is fixed in `fc4e84f9` (T7).
`gen-claude-state.mjs --check`: current. The owner then merged main (`02487c98`) into the branch on GitHub (`03fb1900`,
PR #711): no file shared with this diff; that merged tree is not verified here (CI on #711 runs it). Diff: 25 files (T7 --stat).
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/mainnet-rpc-out-of-client
NOT verified: Vercel Production/Preview and the live bundle; a real chain's cadence (T3 is a stub chain); WalletConnect
wallets relaying reads through the proxy URL; several tabs per IP; the CI jobs (run when the owner opens the PR).
**Owner, after deploy (names only):** 1. confirm `RPC_URL_1` in Production + Preview and the log `rpc: chain=1
source=RPC_URL_1`; 2. rotate the provider key that was in `NEXT_PUBLIC_RPC_URL` (it was in a public chunk); 3. delete
`NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_FALLBACK_RPC_1`, `NEXT_PUBLIC_FALLBACK_RPC_2` in every environment.

### Feedback
- **Edge case:** `npm run dev:fork` reached the fork only through the removed fallback (it would have read real mainnet); now `RPC_URL_1`.
- **Assumption wrong:** 4 literal reads, not 2 (also `wagmiConfig.ts:30-31`, `rpc-env.ts:88`); only `registry.ts:42` shipped.
- **Test changed:** `rpc-env.guard.test.ts:41` asserted rpc-env.ts *contains* a literal read (the bug); the control now scans
  its real text and flags the read once put back; its allow-list is empty.
- **Test gap:** 5 s timeouts under load in source-scan / UI tests (T7), on main too; they need their own timeouts or less work.
- **Concern:** wagmi's server-side mainnet transport lost its two fallbacks; SSR does no reads, so nothing observable changes.
