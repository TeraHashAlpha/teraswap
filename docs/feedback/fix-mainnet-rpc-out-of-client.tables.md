# fix/mainnet-rpc-out-of-client: evidence tables (SEC-5)

Companion to `fix-mainnet-rpc-out-of-client.md`. Names only; every value below is a marker (`.invalid` never resolves).

## T1. Step 0: marker build, client chunks (`.next/static`)

Build env: `NEXT_PUBLIC_RPC_URL=https://mainnet-provider.invalid/v2/CAPTURE-MARKER-MAINNET-RPC-KEY`,
`NEXT_PUBLIC_FALLBACK_RPC_1=https://fallback1-provider.invalid/v2/CAPTURE-MARKER-FALLBACK-RPC-1-KEY`, `_2` likewise, plus the
CI job's existing L2 / Supabase / Sentry markers; `npm run build`, Node 25.6.1.

| Marker | Before: origin/main `4a4129ef` | After: branch `4fdda809` |
|---|---|---|
| `CAPTURE-MARKER-MAINNET-RPC-KEY` / `mainnet-provider.invalid` | **1 file**: `chunks/1_7izng880dte.js` | 0 |
| `CAPTURE-MARKER-FALLBACK-RPC-1-KEY` / `fallback1-provider.invalid` | 0 | 0 |
| `CAPTURE-MARKER-FALLBACK-RPC-2-KEY` / `fallback2-provider.invalid` | 0 | 0 |
| `CAPTURE-MARKER-BASE-RPC-KEY`, `CAPTURE-MARKER-ARBITRUM-RPC-KEY` | 0 | 0 |
| the three mainnet marker hosts anywhere in `.next` (server bundles too) | not measured | 0 |

The one hit, in context: `rpc:{primary:"https://mainnet-provider.invalid/v2/<MARKER>",fallbacks:["https://rpc.…` =
`src/lib/chains/registry.ts:42` at `4a4129ef`. The FALLBACK names (`wagmiConfig.ts:30-31`) and the mainnet read at
`wagmiConfig.ts:29` / `rpc-env.ts:88` did not ship in this build: their only use sat behind `typeof window === 'undefined'`,
which Next folds to false in the client build, and the minifier dropped the dead constant. That is luck, not design.

CI bundle test (`e2e/third-party-hosts/bundle.pw.ts`, `CAPTURE_BUNDLE_MARKERS` = the new e2e.yml list):
- before: **FAIL** `expected [] … received ["<MARKER> in .next/static/chunks/1_7izng880dte.js", "mainnet-provider.invalid in .next/static/chunks/1_7izng880dte.js"]`
- after: **PASS** (2 passed)

## T2. How the browser reaches mainnet (head)

| Reader | file:line | Mainnet | Base / Arbitrum |
|---|---|---|---|
| wagmi transports | `src/lib/wagmiConfig.ts:46-51`, used at `:123-125` | `buildTransport(1)` → browser `guardedHttp(proxyRpcUrl(1))` | `buildTransport(8453 / 42161)`: same function |
| proxy URL | `src/lib/rpc-proxy-url.ts:21-23`, `:26-31` | `<origin>/api/rpc` | `<origin>/api/rpc?chainId=<id>` |
| viem private client | `src/lib/rpc.ts:26-45`, `:53-65` | `fetch('/api/rpc')` | n/a |
| per-chain clients | `src/lib/chains/clients.ts:43-44` (mainnet), `:53-57` (L2) | `getPrivateClient()` → `/api/rpc` | `guardedHttp(proxyRpcUrl(id))` |
| on-chain adapters | `src/lib/adapters/shared.ts:155` | `getRpcUrl()` = `/api/rpc` (`rpc.ts:74`) | `proxyRpcUrl(id)` |
| the proxy's upstream | `src/app/api/rpc/route.ts` → `serverRpcUrl` (`rpc-env.ts:52`, `:141`) | `RPC_URL_1` → `RPC_URL` → `https://eth.llamarpc.com` | `RPC_URL_<id>` → deprecated name → registry fallback (unchanged) |

Same proxy, no fallback in the browser, no new provider. The mainnet browser path was already `/api/rpc` at `4a4129ef`
(`wagmiConfig.ts:41-42`); only the client-reachable env reads changed. The registry keeps the same public endpoints in
the same order (`registry.ts:46-47`), without the env read. The server-side wagmi transport for mainnet is now `serverRpcUrl(1)`
(it was `NEXT_PUBLIC_RPC_URL`, then the two FALLBACK names, then llamarpc).

## T3. Real browser, local production build, mainnet, mock extension wallet connected (`e2e/mainnet-rpc-session`)

Build = the "after" marker build of T1 (the retired names were SET to marker values). Chromium headless shell 1248
(`PW_CHROMIUM`; the 1254 build Playwright asks for is not installed, and installing is out of scope). Real CSP, service
workers blocked. `/api/rpc` = the REAL route; its upstream `RPC_URL_1` = an ABI-aware stub; `/api/quote` = a fixture. One
90 s session per UI: load + connect (to 30 s), one quote (USDC → ETH, 5 USDC), idle to 90 s.

| | v1 (`:3941`) | v2 (`:3942`) |
|---|---|---|
| hosts the browser contacted (HTTP + WS) | `127.0.0.1:3941` only | `127.0.0.1:3942` only |
| marker hosts contacted | none | none |
| third-party / CSP-refused | `[]` / `{}` | `[]` / `{}` |
| console errors / uncaught page errors | 0 / 0 | 0 / 0 |
| balance reads served (`balanceOf` / `getEthBalance`) | 250 / 2 | 1 / 1 |
| allowance reads served (`allowance(owner,spender)`) | 2 | 2 |
| quote | `/api/quote` ×6, swap CTA enabled in 2.8 s | `/api/quote` ×6, "Review swap" enabled in 1.9 s |
| `/api/rpc` answers | 21 × 200 | 18 × 200 |
| JSON-RPC errors (other than the stub's reverts) | 0 | 0 |
| proxy paths read | `/api/rpc` only (mainnet) | `/api/rpc` only (mainnet) |

## T4. Rate-limit units (`RPC_RATE_LIMIT` = 300 units / 60 s per client, `kv-rate-limiter.ts:36`; 1 unit = 1 JSON-RPC call, `rpc-cost-policy.ts:44`)

| Units | v1 | v2 |
|---|---|---|
| loading the swap screen, wallet connected (first 30 s) | 10 | 9 |
| one quote (input to CTA ready + 5 s) | 6 | 5 |
| idle (to 90 s) | 5 | 4 |
| whole 90 s session | 21 | 18 |
| **busiest 60 s window** | **18** (6 % of 300) | **16** (5 % of 300) |

The local server had no Redis, so its limiter ran the in-memory fallback at half the limit (150/min): still 0 refusals.

| Method sent by the mainnet client | v1 | v2 | On the chain-1 allow-list (`rpc-method-policy.ts:26-62`) |
|---|---|---|---|
| `eth_call` | 16 | 13 | yes |
| `eth_blockNumber` | 2 | 2 | yes |
| `eth_chainId` | 1 | 1 | yes |
| `eth_getBlockByNumber` | 1 | 1 | yes |
| `eth_maxPriorityFeePerGas` | 1 | 1 | yes |

`eth_call` targets (Multicall3 opened): `aggregate3`, `balanceOf`, `getEthBalance`, `allowance`, `decimals`, `description`,
`latestRoundData`, `symbol`, `0x7ecebe00` (`nonces`), `0xb7d6ca64`.

## T5. Tests

| File | What | Before the fix | After |
|---|---|---|---|
| `src/lib/next-public-rpc-reads.guard.test.ts` (new) | rules 1-3 + non-vacuity | rule 1, 2, 3×3 red (registry, wagmiConfig, rpc-env, env-validation) | 8/8 green |
| `src/lib/rpc-env.mainnet-server.test.ts` (new) | 5 env states × 5 server paths, real reads | 5/5 red | 5/5 green (alone: 35 / 9 / 19 / 19 / 17 ms after `fc4e84f9`; see T7 run 1) |
| `src/lib/env-validation.rpc.test.ts` (new) | checks follow the chain | 4/5 red against origin/main's `env-validation.ts` (the 5th, "RPC_URL_1 set: no line", holds on both) | 5/5 green |
| `src/lib/rpc-env.test.ts` | mainnet order, empty value, browser order | 2 red | green |
| `src/lib/rpc-env.server-paths.test.ts` | mainnet element of one UNSET case; L2 elements unchanged | 1 red | green |
| `src/lib/wagmiConfig.server.test.ts` | server transport on `RPC_URL_1`, + the URL dialled | 1 red | green |
| `src/lib/rpc-env.guard.test.ts` | allow-list emptied; positive control replaced (see feedback) | n/a | green |
| `scripts/e2e-third-party-hosts-ci.test.mjs` | the three names in `MARKER_ENV` | n/a | green |
| `e2e/mainnet-rpc-session/session.pw.ts` (new, local only) | T3 / T4 | n/a | 2/2 green |
| Base/Arbitrum: `wagmiConfig.browser-transports`, `wagmiConfig.test`, `shared.test`, `uniswapv3.test`, `chains/*`, `api/rpc/*`, rpc-env L2 cases | unchanged files / lines | green | green (39 files, 576 tests in the RPC set) |

## T6. Mutation proof (scratch worktree `mainnet-rpc-out-of-client.mutant`, detached at head, never committed)

**M1** (the goal's): `src/lib/chains/registry.ts` → `primary: process.env.NEXT_PUBLIC_RPC_URL || 'https://eth.llamarpc.com',`.
Full vitest suite: 2282 files, 10870 tests, 10866 passed, 4 failed:

```
FAIL src/lib/next-public-rpc-reads.guard.test.ts > [SEC-5] no client-reachable NEXT_PUBLIC_*RPC* read rule 1: no literal read outside src/app/api/
FAIL src/lib/next-public-rpc-reads.guard.test.ts > [SEC-5] no client-reachable NEXT_PUBLIC_*RPC* read rule 3: NEXT_PUBLIC_RPC_URL appears in no source code under src/ (any form)
FAIL src/lib/rpc-env.guard.test.ts > no direct NEXT_PUBLIC_*RPC* env reads outside the allowlist no offender
FAIL src/config/retired-claims.test.ts > retired claim: TeraSwap makes no MEV-related promise (owner 2026-11-06) no user-facing string in src/ attributes MEV protection to TeraSwap
```
The 4th is NOT the mutant: a 5 358 ms timeout (vitest default 5 s; `STACK_TRACE_ERROR` at `retired-claims.test.ts:104`, a
TypeScript-AST scan of all of src/) under full-suite load. Not rerun (goal rule); it timed out on untouched main too (T7).
The CI bundle check catches M1 too: it is exactly the line the T1 "before" build shipped.

**M2** (sneaky server fallback, computed read, invisible to the bundle check): `rpc-env.ts` `SERVER_NAMES[1]` += and
`DEPRECATED_L2_PUBLIC_NAMES` += `'NEXT_PUBLIC_RPC_URL'`. RPC set (125 files, 484 tests): 5 failed:

```
FAIL src/lib/next-public-rpc-reads.guard.test.ts > … rule 2: no name-as-string-literal outside src/app/api/ and rpc-env.ts; rpc-env.ts holds only the two deprecated L2 names
FAIL src/lib/next-public-rpc-reads.guard.test.ts > … rule 3: NEXT_PUBLIC_RPC_URL appears in no source code under src/ (any form)
FAIL src/lib/rpc-env.mainnet-server.test.ts > … NEXT_PUBLIC_RPC_URL (and the two FALLBACK names) set ALONE: ignored. Public default, the marker host is never dialled
FAIL src/lib/rpc-env.server-paths.test.ts > RPC_URL_<id> UNSET … adapters/shared resolves the deprecated L2 NEXT_PUBLIC_* values; mainnet ignores NEXT_PUBLIC_RPC_URL [SEC-5]
FAIL src/lib/rpc-env.test.ts > server order mainnet: RPC_URL_1 > RPC_URL > llamarpc; NEXT_PUBLIC_RPC_URL is ignored
```

**M3** (fallback name through an alias): `wagmiConfig.ts` server branch → `const env = process.env; guardedHttp(env.NEXT_PUBLIC_FALLBACK_RPC_1 || serverRpcUrl(chainId), …)`.
RPC set: 4 failed:

```
FAIL src/lib/next-public-rpc-reads.guard.test.ts > … rule 1: no literal read outside src/app/api/
FAIL src/lib/next-public-rpc-reads.guard.test.ts > … rule 3: NEXT_PUBLIC_FALLBACK_RPC_1 appears in no source code under src/ (any form)
FAIL src/lib/rpc-env.mainnet-server.test.ts > … NEXT_PUBLIC_RPC_URL (and the two FALLBACK names) set ALONE: ignored. Public default, the marker host is never dialled
FAIL src/lib/rpc-env.mainnet-server.test.ts > … RPC_URL_1 still wins when the browser-era names are also set
```

After `fc4e84f9` reworked the mainnet-server test's setup (T7), M2 and M3 were re-run on that file alone: the same cases
fail (M2: "set ALONE: ignored"; M3: "set ALONE: ignored" and "RPC_URL_1 still wins").

## T7. Verify (`scripts/agent-verify.sh --codeql`, base origin/main `4a4129ef`)

| Check | Run 1 (suite at `04058dbb`) | Run 2 (`fc4e84f9`) |
|---|---|---|
| suite | FAIL 10867 / 3 failed (510 files) | FAIL 10867 / 3 failed (510 files) |
| lint-delta | PASS +0 errors / +0 warnings (17 changed files) | PASS +0 / +0 |
| tsc | PASS 0 errors | PASS 0 errors |
| build | PASS | PASS |
| v1v2-parity | PASS 123 / 0 | PASS 123 / 0 |
| rpc-budget | PASS 36 / 0 | PASS 36 / 0 |
| codeql (security-extended) | PASS head 13, base 13, 0 new | PASS head 13, base 13, 0 new |
| `node scripts/gen-claude-state.mjs --check` | "CLAUDE.md state block is current" | (same tree for the block) |

Suite failures (all `Test timed out in 5000ms`, except the one assertion error marked below):

| Run | Test | Duration | In this diff? |
|---|---|---|---|
| 1 | `src/lib/rpc-env.mainnet-server.test.ts` "only RPC_URL_1 set" | 5 033 ms | **yes, mine**: cold load inside the case; fixed in `fc4e84f9` (fix attempt 1) |
| 1 | `src/lib/rpc-env.mainnet-server.test.ts` "nothing set" | 1 150 ms | **yes**: assertion error caused by the previous case's leaked reads; same fix |
| 1 | `src/hooks/useQuote.log-quote.callers.test.ts:163` | timeout | no |
| 2 | `src/hooks/useQuote.log-quote.callers.test.ts:163` | 6 697 ms | no |
| 2 | `src/ui/v2/modals/token-sheet.test.tsx:78` | 6 747 ms | no |
| 2 | `src/components/TokenSelector.imported-hygiene.test.tsx:88` | 5 034 ms | no |
| M1 run | `src/config/retired-claims.test.ts:104` | 5 358 ms | no |

Machine load during these runs (other sessions' `agent-verify --keeper --codeql` in `keeper-active-orders-window` and
`log-routes-bounded-input`): load average 25.8 / 64.4 / 63.1 on 10 cores, measured at 23:43. None of the timed-out
files is rerun alone on the branch (goal rule).

Proof on main: the same command (`CI=1 npx --no-install vitest run`) on untouched origin/main `4a4129ef` in the scratch
worktree, same machine, same kind of load (load average 24.8 / 62.3 / 62.3 at start, 73.3 / 73.1 / 67.7 at end):
2 275 files, 10 845 tests, **2 failed**, both 5 s timeouts (`STACK_TRACE_ERROR`): `scripts/agent-hooks.test.mjs`
"allows: git ls-files -- <harness hooks dir>" (5 670 ms) and `src/config/retired-claims.test.ts:104` (6 614 ms). The three
that timed out on the branch passed on main this time, close to the line: token-sheet 3 615 ms, useQuote callers
3 411 ms, TokenSelector hygiene 2 625 ms.

`git diff --stat origin/main` (with this file's commit):

```
 .env.example                                       |  21 +-
 .github/workflows/e2e.yml                          |   6 +-
 docs/Runbooks/ENV-RPC.md                           |  25 +-
 docs/Runbooks/vercel-breach-rotation.md            |   6 +-
 docs/feedback/fix-mainnet-rpc-out-of-client.md     |  50 ++++
 .../fix-mainnet-rpc-out-of-client.tables.md        | 1xx ++++++++++++++
 docs/guides/E2E-FORK-TEST.md                       |   5 +-
 e2e/mainnet-rpc-session/playwright.config.ts       |  52 ++++
 e2e/mainnet-rpc-session/session.pw.ts              | 262 +++++++++++++++++++++
 e2e/third-party-hosts/bundle.pw.ts                 |   3 +-
 e2e/third-party-hosts/cow-flow.ts                  |   3 +-
 package.json                                       |   2 +-
 scripts/e2e-third-party-hosts-ci.test.mjs          |   3 +-
 src/lib/chains/registry.ts                         |   6 +-
 src/lib/env-validation.rpc.test.ts                 |  57 +++++
 src/lib/env-validation.ts                          |  16 +-
 src/lib/next-public-rpc-reads.guard.test.ts        | 109 +++++++++
 src/lib/rpc-env.guard.test.ts                      |  21 +-
 src/lib/rpc-env.mainnet-server.test.ts             | 166 +++++++++++++
 src/lib/rpc-env.server-paths.test.ts               |   6 +-
 src/lib/rpc-env.test.ts                            |  18 +-
 src/lib/rpc-env.ts                                 |  21 +-
 src/lib/rpc.ts                                     |   2 +-
 src/lib/wagmiConfig.server.test.ts                 |  21 +-
 src/lib/wagmiConfig.ts                             |  87 ++-----
 25 files changed
```
