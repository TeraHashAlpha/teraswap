# Feedback — fix/v1-maintenance

Base: origin/main `a5cd8fe`. Worktree `~/ts-worktrees/v1-maintenance`. No PR (owner opens). No CI poll.

## Checklist
- [x] C1 tx links use the order's chain
- [x] C2 Portfolio L2 classification
- [x] C3 Portfolio hidden-tab polling
- [x] C4 serialise saveOrders
- [x] C5 shared escapeRegExp (test-utils)
- [x] Verify: suite vs main · lint delta · tsc · build · rpc-budget · CodeQL (full security-extended)

## 1. Items (change · file:line · test · fails-on-main)
| # | Change | Where | Test | Fails on main |
|---|--------|-------|------|---------------|
| C1 | `explorerTxUrl(…, 1)` → order's chain; `ExecutionTimeline` gets `chainId` prop (default 1) | `OrderDashboard.tsx` (link + `chainId={orderChainId}`), `ExecutionTimeline.tsx` (prop + link) | `ExecutionTimeline.test.tsx`, `OrderDashboard.test.tsx` "per-chain explorer link" (1/8453/42161, `new URL()` hostname; wallet stays on 1) | yes: 4/6 new cases red (8453, 42161 in both files) before the fix |
| C2 | curated vs Discovered uses the ACTIVE chain's list: new `isCuratedToken(address, chainId)` | `lib/chains/tokens.ts` (helper), `PortfolioTab.tsx` `isDefaultToken(token, activeChainId)`; v2 `portfolio-model.ts` + `PortfolioTab.tsx` (restated mainnet-only copy, same fix) | `PortfolioTab.test.tsx` (USDC 8453/42161 curated; unknown still Discovered+Add; mainnet addr on Base is Discovered), `tokens.test.ts`, v2 `portfolio.test.tsx` parity (own USDC curated in both tabs) | yes: 7 new cases red on main (2 "unknown stays discovered" guards pass on both) |
| C3 | both 60 s API timers (discovery + prices) pause when hidden; one refresh on visible; new `setVisibleInterval` | `lib/visible-interval.ts`, `hooks/usePortfolio.ts` (discovery + prices effects) | `usePortfolio.test.ts` "hidden-tab polling" (fake timers, mocked `visibilityState`) | yes: 3/5 red on main (hidden, visible-again, mounted-hidden); baseline + unmount guards pass on both |
| C4 | `saveOrders` writes queued per storage key (FIFO, payload snapshotted at call time, failed write doesn't block); `saveOrders` now exported for the test | `hooks/useOrderEngine.ts` `enqueueWrite` + `saveOrders` | `useOrderEngine.save-ordering.test.ts` (controllable `secureSet`, newest write settled first) | yes: run vs origin/main's body (exported) → 3/4 red (final state = older list); snapshot guard passes on both |
| C5 | one shared escaper; the 2 v2 test copies import it; keeper copy kept + pointer comment | `src/test-utils/escape-regexp.ts`; `narrative.test.tsx:11`, `shell.test.tsx:91`; `redact.test.mjs:229` (comment) | `src/test-utils/escape-regexp.test.ts` (every metachar + backslash round-trip) | yes: module absent on main → test file cannot resolve (red); keeper 23/23 |

## v2 parity tests updated
- `ui/v2/portfolio/portfolio-a11y.test.tsx`: fixture ran on Base with MAINNET ETH/USDC addresses (only "curated" because v1's set ignored the chain) → now Base's own ETH/USDC from `getChainTokenList(8453)`.
- `ui/v2/portfolio/portfolio.test.tsx`: +1 parity case (own USDC curated in v1 and v2 on 1/8453/42161).

## Findings
### Edge case
- C4: FIFO, not coalescing — every save still lands (no behaviour change); 2 fast saves = 2 encryptions in sequence. The two call sites (`useEffect` on `orders`, `removeOrder`) and `loadOrders`' legacy migration all go through the same queue. A cross-tab race on the same key is out of scope (localStorage, no lock).
- C3: "its own API timer" is TWO timers (discovery + prices, both 60 s) — both paused. Initial fetch on mount is unchanged (also when mounted hidden). `useBalance`'s `refetchInterval: 30_000` is TanStack (already background-paused), untouched.
- C2: premise partly false — v2 does NOT render through a shared classifier; `portfolio-model.ts` restated v1's mainnet-only set ("on every chain"). Fixed there too via the shared `isCuratedToken`, else v1/v2 would diverge on L2. "Catalog" = `getChainTokenList` (curated list, what `usePortfolio` already uses for metadata), not the full search catalog (long tail would hide real Add candidates).
- C1: `LimitOrderPanel.tsx:1044`, `ConditionalOrderPanel.tsx:917`, `SwapBox.tsx:1193/1203`, `ToastProvider.tsx:182`, `AdminMonitor.tsx:837` still use `ETHERSCAN_TX` (mainnet-only). They are creation/toast/admin surfaces, not Orders/fill rows → left untouched (out of scope + read-scope); worth a follow-up if those panels can run on L2.

## 3-5. Evidence
3. **CodeQL** (`scripts/codeql-local.sh`, full `javascript-security-extended`): origin/main 13 alerts → head 13, identical set, 0 new, 0 in changed files.
4. **Suite** vitest: main 411 files / 6572 tests → head 413 / 6601 (+2 files, +29 tests, 0 failed; includes `ui/v2/__tests__/rpc-budget` guards, green).
   **Lint** eslint 93 warnings / 0 errors on both (delta 0) · **tsc** 0 errors · **`next build`** ok · keeper `redact.test.mjs` 23/23.
5. **diff --stat** origin/main..HEAD: 23 files, +467 / −44, 5 code commits (all SSH-signed, noreply committer) + this feedback edit.
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/v1-maintenance (no PR opened).
   Not touched: swap/DCA execution, gates, signing, approvals, API routes; no new deps/secrets.

## PR #655 follow-up — `api-hardening-guard` flake (C4 side-effect)
- **Symptom:** `useOrderEngine.test.ts:813` "survives unmount + remount" → `expected [] to have a length of 1`. CI command (`ci.yml:362`) ×20: **branch 15/20, main (`3869606`) 20/20**; all 5 failures this one test.
- **Cause:** C4's queue is module-level. A case that returns right after its first write lands ("writes an encrypted payload") leaves later writes queued; orders are deterministic (same `orderHash` in every case), so one landing after the next case's `localStorage.clear()` satisfied the waitFor with a stale copy, then the case's own empty-list write landed before the remount read. Production ordering is correct (FIFO); the leak is test isolation.
- **Fix:** `flushOrderWrites()` (hook module) awaited in the file's `afterEach`; +1 unit test for it. No assertion/timeout/retry changed.
- **Counts (CI command ×20):** before fix 15/20 · after fix **20/20** · main 20/20 · fix reverted, run alone 18/20 (same test) → causal.
- Suite 413 files / 6602 tests green · lint 93 warn / 0 err · tsc clean · build ok. origin/main moved to `3869606` (package.json + lockfile only). The owner's merge of it (`c946038`) was on the remote; my 2 unpushed commits were rebased onto it (no force-push) and the 20× loop re-run on that merged state: **20/20**.
