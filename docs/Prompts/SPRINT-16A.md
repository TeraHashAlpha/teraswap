# Sprint 16A — Backlog Cleanup: External 5M + Foundry Tests + Adapter Tests

**Sprint window:** Post-Sprint 15 APPROVED → TBD
**Sprint goal:** Close the 5 MEDIUM findings from the external technical analysis (2026-04-22), fix the 8 Foundry test failures (15-I-01), and add missing adapter recipient tests (14-I-02). Zero open MEDIUM findings by sprint end.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 15 APPROVED. All HIGHs closed. ERC-7730 PR submitted.
**References:**
- External analysis: `Audits/TeraSwap-Technical-Analysis-2026-04-22.pdf`
- Response document: `Audits/TeraSwap-Analysis-Response-2026-04-23.docx`
- Security tracker: `docs/security/AUDIT-TOTAL.md`
- Sprint 14 audit (14-I-02): `Audits/Sprint/audit-sprint-14.md`
- Sprint 15 audit (15-I-01): `Audits/Sprint/audit-sprint-15.md`

---

## Architecture Context

**The problem:** 5 MEDIUM findings from the paid external analysis remain open since April 2026. While all 4 HIGHs were closed in Sprint 9A/9B, the MEDIUMs have been deferred across 6 sprints. Additionally, Sprint 15 exposed 8 latent Foundry test failures (15-I-01), and 3 adapter recipient tests are still missing (14-I-02). This technical debt accumulates risk as we build new features on top.

**Why now:** Before starting Positive Slippage Sharing (Sprint 16B), which introduces a new FeeCollector V3 or adapter contract, we need a clean security baseline. M-03 (Supabase blast radius) is especially relevant if payment flows expand. M-01 (frontend tests) protects the user-facing security UX as the codebase grows.

**Scope decisions:**
- M-01 is scoped to Phase 1: the 4 security-critical hooks (useSwap, useApproval, useQuote, useChainlinkPrice) + 3 critical components (TransactionPreview, SwapButton, Permit2EducationModal). Full component coverage deferred to Sprint 17.
- M-03 requires a Supabase Dashboard change (creating a new role) — the prompt provides the migration SQL + instructions, but the Dashboard step is manual.
- 15-I-01 requires running `forge test` locally to identify the exact 8 failing tests before fixing.

---

## RICE Prioritisation

| # | Prompt | R | I | C | E | RICE | Priority |
|---|--------|---|---|---|---|------|----------|
| 109 | M-05: On-chain monitor every tick | 8 | 2 | 0.9 | 0.25 | 57.6 | P0 |
| 110 | M-04: Grace alert consistency | 6 | 1 | 0.9 | 0.15 | 36.0 | P1 |
| 111 | 14-I-02: CoW/UniV3/Curve recipient tests | 5 | 2 | 0.9 | 0.25 | 36.0 | P1 |
| 112 | M-02: Circuit breaker KV sync | 7 | 2 | 0.8 | 0.5 | 22.4 | P1 |
| 113 | 15-I-01: Fix 8 Foundry test failures | 6 | 2 | 0.9 | 0.5 | 21.6 | P1 |
| 114 | M-03: Supabase least-privilege role | 5 | 2 | 0.7 | 0.5 | 14.0 | P2 |
| 115 | M-01 Phase 1: Frontend integration tests | 8 | 2 | 0.8 | 1.0 | 12.8 | P2 |

**Total estimated effort:** ~3.15 pw
**Execution order:** P109 → P110 → P111 → P112 → P113 → P114 → P115

---

## Sprint status table

| # | Prompt | Description | Finding | Status |
|---|--------|------------|---------|--------|
| 109 | On-chain monitor cadence | Scan every tick (60s) instead of every 5th | M-05 | Pending |
| 110 | Grace alert consistency | Apply [GRACE] tag to all channels | M-04 | Pending |
| 111 | Adapter recipient tests | Add CoW/UniV3/Curve to recipient.test.ts | 14-I-02 | Pending |
| 112 | Circuit breaker KV sync | Pre-set breaker state from KV on cold start | M-02 | Pending |
| 113 | Foundry test fixes | Fix 8 failing tests in OrderExecutor.t.sol | 15-I-01 | Pending |
| 114 | Supabase least-privilege | INSERT-only role for logging tables | M-03 | Pending |
| 115 | Frontend integration tests | Phase 1: 4 hooks + 3 components | M-01 | Pending |

---

## Prompt 109 — M-05: On-Chain Monitor — Scan Every Tick

**Status:** Pending
**Closes:** M-05 (External Analysis)

**Context:** `src/lib/on-chain-monitor.ts` currently runs on every 5th monitoring tick (~5 minutes). Critical contract events (AdminTransferred, Paused, OwnershipTransferred, RouterUpdated) are detected with up to 5+ min delay. The Cloudflare Worker already fires every 60s, so scanning every tick requires no infrastructure changes — just a code change.

**Objective:** Reduce on-chain event detection latency from ~5 minutes to ~60 seconds for all monitored events.

**Requirements:**

1. **In `src/lib/on-chain-monitor.ts`** — remove the tick-modulo gate that limits scanning to every 5th tick. The function should execute on every call from the monitoring loop.

2. **RPC cost mitigation** — add a simple block-range cache:
   - Track `lastScannedBlock` in the module scope (in-memory, acceptable to lose on cold start).
   - On each tick, fetch `eth_blockNumber`, skip if `currentBlock <= lastScannedBlock`.
   - Query `eth_getLogs` only for `lastScannedBlock + 1 .. currentBlock`.
   - This prevents duplicate scans within the same block and keeps RPC calls to 1-2 per tick.

3. **Add FeeCollector V2 address** to the monitored contracts if not already present:
   - `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`
   - Monitor: `Paused`, `Unpaused`, `OwnershipTransferred`, `RouterAdded`, `RouterRemoved`

4. **Update monitoring metrics** — if there's a scan-count metric or log, update it to reflect per-tick cadence.

**Do NOT:**
- Add WebSocket subscriptions (not available on all RPC providers, evaluate in Sprint 17)
- Change the Cloudflare Worker cron interval (already 60s)
- Modify the alert-wrapper channel logic (that's P110)

**Files affected:**
- `src/lib/on-chain-monitor.ts`

**Expected output:** 1 commit. On-chain events detected within 60s of block confirmation.

**Quality criteria:**
- `npm test` — all 572+ tests pass
- `npx tsc --noEmit` — no type errors
- No new lint warnings
- Block-range cache prevents duplicate event processing

---

## Prompt 110 — M-04: Grace Period Alert Consistency Across Channels

**Status:** Pending
**Closes:** M-04 (External Analysis)

**Context:** `src/lib/alert-wrapper.ts` applies the `[GRACE]` tag only to Telegram alerts during grace periods. Email and Discord receive unsuppressed alert floods during planned maintenance. The inconsistency causes alert fatigue and confusion for non-Telegram channels.

**Objective:** Apply consistent grace-period handling across all alert channels (Telegram, Email, Discord).

**Requirements:**

1. **In `src/lib/alert-wrapper.ts`** — when a grace period is active:
   - Tag ALL channel outputs with `[GRACE]` prefix (not just Telegram).
   - For Email: prepend `[GRACE]` to subject line and add a banner to body: "⚠️ Alert received during grace period — may resolve automatically."
   - For Discord: prepend `[GRACE]` to message content.

2. **P0 alerts are NEVER suppressed** — regardless of grace period, P0 (critical) alerts bypass the [GRACE] tag and are sent at full severity to all channels. This existing behaviour for Telegram must be preserved and extended to all channels.

3. **Grace period summary** — at grace period end, send a summary to all channels:
   - Count of suppressed alerts by category
   - "Grace period ended — normal alerting resumed"
   - Only send if at least 1 alert was tagged during the period.

4. **Add test coverage** for the new behaviour:
   - Test: during grace, non-P0 alert is tagged on all channels
   - Test: during grace, P0 alert is NOT tagged on any channel
   - Test: grace end summary is sent with correct counts

**Do NOT:**
- Add alert suppression (all alerts still send, they just get tagged)
- Change the grace period detection logic
- Modify the Telegram-specific formatting beyond the [GRACE] tag

**Files affected:**
- `src/lib/alert-wrapper.ts`
- `src/lib/alert-wrapper.test.ts` (add new tests)

**Expected output:** 1 commit. All 3 channels behave consistently during grace periods.

**Quality criteria:**
- `npm test` — all tests pass, new tests included
- `npx tsc --noEmit` — no type errors
- Manual verification: grep for `[GRACE]` shows consistent usage across channels

---

## Prompt 111 — 14-I-02: CoW, UniswapV3, and Curve Adapter Recipient Tests

**Status:** Pending
**Closes:** 14-I-02 (Sprint 14 audit)

**Context:** `src/lib/adapters/recipient.test.ts` tests recipient threading for 7 of 11 adapters (Balancer, KyberSwap, Velora, SushiSwap, 1inch, Odos, OpenOcean) but is missing tests for CoW, UniswapV3, and Curve. The existing test pattern: mock `global.fetch`, call adapter with/without `recipient` param, assert correct address appears in the outbound request.

**Objective:** Add recipient threading tests for CoW, UniswapV3, and Curve adapters, following the existing pattern.

**Requirements:**

1. **CoW adapter** (`src/lib/adapters/cow.ts`):
   - Read the adapter code to identify how `recipient` is passed in the CoW order body (likely `receiver` field in the EIP-712 order struct).
   - Test: when `recipient` is provided, it appears as `receiver` in the POST body to the CoW orderbook API.
   - Test: when `recipient` is omitted, `from` address is used as `receiver`.
   - Mock the CoW API response appropriately (the adapter may have a multi-step flow: quote → sign → submit).

2. **UniswapV3 adapter** (`src/lib/adapters/uniswapv3.ts`):
   - Read the adapter code to identify how `recipient` is threaded (likely ABI-encoded in the swap params or as a query parameter).
   - Test: recipient passed through correctly.
   - Test: defaults to `from` when omitted.
   - Handle any ABI encoding in assertions (may need to decode calldata to verify recipient).

3. **Curve adapter** (`src/lib/adapters/curve.ts`):
   - Read the adapter code to identify recipient mechanism.
   - Test: recipient passed through correctly.
   - Test: defaults to `from` when omitted.
   - Note: Curve may not support custom recipients natively — if the adapter logs a warning (like OpenOcean does), test that behaviour instead.

4. **Follow the existing pattern exactly:**
   - Same `describe` block structure as existing adapters
   - Same `mockFetch`, `lastBody()`, `bodyAtCall()`, `urlAtCall()` helpers
   - Same `FROM`, `RECIPIENT`, `BASE` constants
   - Place new describe blocks after the existing ones, maintaining alphabetical or source-list order

**Do NOT:**
- Modify existing adapter tests
- Change adapter implementation code (tests only)
- Add the 0x adapter (flagged as `FEE_INCOMPATIBLE_SOURCES`, not needed)

**Files affected:**
- `src/lib/adapters/recipient.test.ts`

**Expected output:** 1 commit. 6+ new test cases (2 per adapter).

**Quality criteria:**
- `npm test` — all tests pass, 3 new describe blocks
- Each adapter has "passes recipient through" + "defaults to from" tests
- No mocking leaks between tests (beforeEach/afterEach cleanup maintained)

---

## Prompt 112 — M-02: Circuit Breaker KV Sync on Cold Start

**Status:** Pending
**Closes:** M-02 (External Analysis)

**Context:** `src/lib/adapters/circuit-breaker.ts` uses an in-memory `Map` for per-adapter circuit breaker state. Every Vercel cold start resets all breakers to CLOSED. It takes 3 consecutive failures (~90s) to re-open a breaker for a source that's already known to be failing in KV. During that window, requests are sent to failing sources, degrading quote latency and user experience.

**Objective:** On adapter initialization (cold start), pre-seed the in-memory circuit breaker state from KV source state.

**Requirements:**

1. **In `src/lib/adapters/circuit-breaker.ts`** — add an `initFromKV()` async function:
   - Read the KV source state for all 11 adapters.
   - For each adapter marked `disabled` or `degraded` in KV, set the in-memory breaker to `OPEN` with a TTL matching the KV state's remaining cooldown.
   - For adapters in `healthy` state, leave the breaker `CLOSED` (default).
   - This function is idempotent — safe to call multiple times.

2. **Call `initFromKV()` on first use** — use a module-level `initialized` flag:
   ```
   let initialized = false
   export async function getCircuitBreaker(source: string) {
     if (!initialized) { await initFromKV(); initialized = true }
     return breakers.get(source) ?? createBreaker(source)
   }
   ```

3. **Graceful degradation** — if KV is unavailable (network error, rate limit), log a warning and proceed with default CLOSED state (current behaviour). Never block the critical path on KV reads.

4. **Add test coverage:**
   - Test: when KV reports source X as disabled, in-memory breaker starts OPEN
   - Test: when KV is unavailable, all breakers default to CLOSED
   - Test: `initFromKV()` is called only once (idempotent flag)

**Do NOT:**
- Add real-time KV sync (periodic polling) — that's a future enhancement
- Change the KV source state machine itself
- Modify the failure-counting logic (3 failures → OPEN remains unchanged)

**Files affected:**
- `src/lib/adapters/circuit-breaker.ts`
- `src/lib/adapters/circuit-breaker.test.ts` (add new tests)

**Expected output:** 1 commit. Cold start recovery window reduced from ~90s to ~0s for sources already marked in KV.

**Quality criteria:**
- `npm test` — all tests pass
- `npx tsc --noEmit` — no type errors
- KV read failure does not crash the adapter layer
- `console.warn` emitted on KV fallback path

---

## Prompt 113 — 15-I-01: Fix 8 Failing Foundry Tests in OrderExecutor.t.sol

**Status:** Pending
**Closes:** 15-I-01 (Sprint 15 audit)

**Context:** Sprint 15's P107 fixed Foundry CI compilation by excluding `lib/openzeppelin-contracts/fv/`. This exposed 8 pre-existing test failures in `contracts/order-engine/test/TeraSwapOrderExecutor.t.sol` (69 total tests, 61 passing). Root causes are suspected to be: (1) DCA timing fixtures (warp timing off), (2) MockERC20 balance/allowance mismatches, (3) EIP-712 signature helper producing invalid signatures for certain order configurations.

**Objective:** Make all 69 Foundry tests pass. The OrderExecutor v2 is deployed on Sepolia — these tests must be green before mainnet deployment.

**Requirements:**

1. **Diagnose first** — run `forge test -vvv 2>&1 | head -200` from `contracts/order-engine/` to identify the exact 8 failing test names and their error messages. Document each in a comment at the top of the commit.

2. **Fix categories (expected, verify each):**
   - **DCA timing tests** — check `vm.warp()` values against `order.interval`. If the test warps to `block.timestamp + interval` but the contract checks `>=`, a 1-second offset may fix it. Verify against the contract's `_isDCAExecutable()` logic.
   - **Balance/allowance tests** — ensure `MockERC20.mint()` and `MockERC20.approve()` amounts match what `executeOrder()` expects after fee deduction. The FeeCollector V2's fee is 0.1% (10 bps) — verify test fixtures account for this.
   - **Signature fixtures** — check that `_signOrderMemory()` uses the correct domain separator (`DOMAIN_SEPARATOR` from the deployed test contract, not a hardcoded value). Verify `chainId` and `verifyingContract` match the test environment.

3. **Do NOT change contract logic** — only fix test setup, fixtures, and assertions. If a test reveals an actual contract bug, document it in FEEDBACK.md and leave the test as `@skip` with a comment.

4. **Remove `continue-on-error: true`** from `.github/workflows/ci.yml` for the `test-contracts` job (if still present). Foundry tests must now block the pipeline.

**Do NOT:**
- Modify `TeraSwapOrderExecutor.sol` (contract code)
- Delete or skip tests without documenting the reason
- Change `foundry.toml` (already configured correctly by P107)

**Files affected:**
- `contracts/order-engine/test/TeraSwapOrderExecutor.t.sol`
- `.github/workflows/ci.yml` (remove `continue-on-error` if present)
- `FEEDBACK.md` (if contract bugs found)

**Expected output:** 1 commit. `forge test` shows 69/69 passing. CI `test-contracts` job goes green and blocks on failure.

**Quality criteria:**
- `forge test` — 69/69 pass (0 failures, 0 errors)
- `continue-on-error` removed from CI for contract tests
- Each fix is documented in commit message (which test, what was wrong, what changed)

---

## Prompt 114 — M-03: Supabase Least-Privilege Role for Logging Tables

**Status:** Pending
**Closes:** M-03 (External Analysis)

**Context:** `src/lib/supabase.ts` uses the `service_role` key for all server-side operations, bypassing RLS. This key has full read/write/delete access to every table. The external analysis (M-03) recommends creating a dedicated INSERT-only role for logging/analytics tables, limiting the blast radius if the key is ever leaked.

**Objective:** Create a `logger` Supabase role with INSERT-only permissions on logging tables. Use this role's key for fire-and-forget analytics writes.

**Requirements:**

1. **Create a Supabase migration** (`supabase/migrations/YYYYMMDD_logger_role.sql`):
   ```sql
   -- Create a logger role with INSERT-only on analytics tables
   CREATE ROLE logger_role NOLOGIN;
   GRANT INSERT ON swap_history TO logger_role;
   GRANT INSERT ON quote_analytics TO logger_role;
   GRANT INSERT ON aggregator_analytics TO logger_role;
   GRANT INSERT ON api_usage TO logger_role;
   -- No SELECT, UPDATE, DELETE on any table
   -- No access to orders, api_keys, or other sensitive tables
   ```
   Adjust table names to match the actual schema.

2. **In `src/lib/supabase.ts`** — export a second Supabase client:
   ```typescript
   export const supabaseLogger = createClient(
     process.env.SUPABASE_URL!,
     process.env.SUPABASE_LOGGER_KEY!,
     { auth: { persistSession: false } }
   )
   ```

3. **Replace service-role usage in logging paths** — find all fire-and-forget `supabase.from('swap_history').insert(...)`, `supabase.from('quote_analytics').insert(...)`, etc. that use `Promise.resolve().catch()` or similar patterns. Replace `supabase` with `supabaseLogger` in these calls only.

4. **Keep `supabase` (service-role) for:**
   - Order operations (need full CRUD)
   - API key management (need SELECT + UPDATE)
   - Any operation that reads data

5. **Add `SUPABASE_LOGGER_KEY` to environment:**
   - Document in `.env.example`
   - Add to Vercel environment variables (manual step — document in commit message)
   - NOTE: The actual key creation must be done in the Supabase Dashboard (Settings → API → Generate new key with custom claims for `logger_role`). Document the steps clearly.

**Do NOT:**
- Remove the service-role key (still needed for order operations)
- Change RLS policies (they work on the anon key, not service-role)
- Run the migration automatically (Supabase migrations require manual apply or CI pipeline)

**Files affected:**
- `supabase/migrations/YYYYMMDD_logger_role.sql` (new)
- `src/lib/supabase.ts`
- All files with fire-and-forget analytics inserts (find with grep for `.insert(` + `.catch(`)
- `.env.example`

**Expected output:** 1 commit + manual Supabase Dashboard steps documented in commit message.

**Quality criteria:**
- `npm test` — all tests pass
- `npx tsc --noEmit` — no type errors
- `grep -r "supabase\." src/` — no service-role usage in pure logging paths
- Migration SQL is idempotent (uses `IF NOT EXISTS` or handles existing role)

---

## Prompt 115 — M-01 Phase 1: Frontend Integration Tests for Security-Critical Hooks + Components

**Status:** Pending
**Closes:** M-01 (External Analysis) — Phase 1 only

**Context:** The external analysis (M-01) flagged zero test coverage for all React components and hooks. This is the single largest gap in the test suite. Phase 1 covers the 4 security-critical hooks and 3 components identified by the analysts. Phase 2 (remaining components) is deferred to Sprint 17.

**Objective:** Add integration tests for the hooks and components that form the user's last line of defence against bad swaps.

**Requirements:**

### Hooks (create test files alongside each hook)

1. **`src/hooks/useSwap.test.ts`** — test the swap execution pipeline:
   - Test: `validateFeeIntegrity` is called before execution
   - Test: `validateRouterAddress` rejects unknown routers
   - Test: `KNOWN_SWAP_SELECTORS` check blocks unknown selectors
   - Test: `validateCallDataRecipient` blocks recipient mismatch
   - Test: PriceGuardError prevents swap execution
   - Test: post-execution validator is triggered after successful swap
   - Mock: wagmi hooks, viem contract calls, fetch for API calls

2. **`src/hooks/useApproval.test.ts`** — test approval planning:
   - Test: native token (ETH) skips approval
   - Test: existing sufficient allowance skips approval
   - Test: Permit2 path detected when EIP-2612 is available
   - Test: Permit2 education modal triggers on first use (`isPermit2Educated()` returns false)
   - Test: standard approval flow for non-Permit2 tokens

3. **`src/hooks/useQuote.test.ts`** — test quote fetching:
   - Test: debounce prevents rapid API calls
   - Test: stale quotes are discarded (race condition guard)
   - Test: error handling for API failures (non-200 responses)
   - Test: gasless analysis flag is passed when CoW is available

4. **`src/hooks/useChainlinkPrice.test.ts`** — test price guard:
   - Test: deviation `none` when price within 2%
   - Test: deviation `warn` when price between 2-3%
   - Test: deviation `danger` when price >3%
   - Test: `oracleUnavailable: true` when no feed exists
   - Test: stale price detection (timestamp > threshold)

### Components (create test files alongside each component)

5. **`src/components/TransactionPreview.test.tsx`** — test clear signing modal:
   - Test: FeeCollector V2 calldata is decoded correctly
   - Test: recipient badge shows "Your wallet" for sender === recipient
   - Test: recipient badge shows "FeeCollector" for known contract
   - Test: recipient badge shows "Unknown" for unrecognised address
   - Test: `minimumOutput` is displayed in human-readable format

6. **`src/components/SwapButton.test.tsx`** — test button states:
   - Test: shows "Connect Wallet" when not connected
   - Test: shows "Switch Network" when wrong chain
   - Test: shows "Approve" when approval needed
   - Test: shows "Swap" when ready
   - Test: disabled with reason when `priceBlocked` is true
   - Test: click triggers swap execution

7. **`src/components/Permit2EducationModal.test.tsx`** — test education flow:
   - Test: modal renders when `isPermit2Educated()` returns false
   - Test: "Don't show again" sets localStorage flag
   - Test: Escape key closes modal
   - Test: onConfirm callback fires on "I understand" click
   - Test: focus trap prevents tabbing out

### Test infrastructure

8. **Use `@testing-library/react`** + `vitest` (already in devDependencies). If `@testing-library/react` is not installed, add it + `@testing-library/jest-dom`.

9. **Create `src/test-utils/` directory** (if not exists) with:
   - `mock-wagmi.ts` — wagmi hook mocks (useAccount, useChainId, usePublicClient, useSendTransaction)
   - `mock-providers.tsx` — test wrapper with WagmiConfig + QueryClient
   - `render.tsx` — custom render that wraps components in mock providers

**Do NOT:**
- Test implementation details (e.g., internal state) — test behaviour and outputs
- Mock at too low a level (prefer mocking fetch/wagmi over internal functions)
- Add E2E/Playwright tests (that's Phase 3)
- Test non-security components (SwapHistory, AnalyticsDashboard, etc.)
- Modify component or hook source code

**Files affected:**
- `src/hooks/useSwap.test.ts` (new)
- `src/hooks/useApproval.test.ts` (new)
- `src/hooks/useQuote.test.ts` (new)
- `src/hooks/useChainlinkPrice.test.ts` (new)
- `src/components/TransactionPreview.test.tsx` (new)
- `src/components/SwapButton.test.tsx` (new)
- `src/components/Permit2EducationModal.test.tsx` (new)
- `src/test-utils/mock-wagmi.ts` (new, if needed)
- `src/test-utils/mock-providers.tsx` (new, if needed)
- `src/test-utils/render.tsx` (new, if needed)
- `package.json` (add @testing-library/react if missing)

**Expected output:** 1-2 commits. ~30-40 new test cases across 7 test files.

**Quality criteria:**
- `npm test` — all tests pass (existing + new)
- `npx tsc --noEmit` — no type errors
- Coverage: every security-critical path in the 4 hooks has at least 1 test
- No snapshot tests (brittle, avoid)
- Test names describe the behaviour being verified, not the implementation

---

## Post-Sprint Checklist

After all prompts are implemented and auditor approves:

1. [ ] Update `docs/security/AUDIT-TOTAL.md` — mark M-01 through M-05 as CLOSED with commit hashes
2. [ ] Update `Audits/Sprint/audit-sprint-16a.md` — auditor verdict
3. [ ] Run `npm test` — verify total test count (target: ~610+)
4. [ ] Run `forge test` from `contracts/order-engine/` — verify 69/69 passing
5. [ ] Update `CLAUDE.md` current state section
6. [ ] Apply Supabase migration (P114, manual step)
7. [ ] Add `SUPABASE_LOGGER_KEY` to Vercel env vars (P114, manual step)
8. [ ] Begin Sprint 16B — Positive Slippage Sharing
