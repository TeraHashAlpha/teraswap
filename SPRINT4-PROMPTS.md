# Sprint 4 — Prompts Pendentes

## PROMPT 17 — Sprint 4: On-Chain Event Monitoring & Price Guard Alerts (R6 + R8)

**Context:** The TeraSwapOrderExecutor emits events for all admin actions (`TimelockQueued`, `TimelockExecuted`, `TimelockCancelled`, `AdminTransferred`, `RouterWhitelisted`, `Paused`, `Unpaused`, `SweepQueued`), but nothing monitors them. The Drift Protocol hack ($285M, April 2026) succeeded because admin changes went undetected. Additionally, the DefiLlama price guard can block high-value swaps, but consecutive blocks (suggesting oracle manipulation or market anomaly) don't trigger any alert.

The executor already has a Telegram alerting module (`contracts/order-engine/executor/alert.js`) and a monitoring class (`contracts/order-engine/executor/monitor.js`). We extend this infrastructure.

**Objective:** Add an on-chain event watcher that monitors admin events and sends Telegram alerts. Add consecutive price-guard-block detection to the API.

**Requirements:**

1. **Create `contracts/order-engine/executor/event-watcher.js`** — standalone module:
   - Uses viem's `watchContractEvent` (or polling `getContractEvents` every 30s) on the OrderExecutor contract
   - Monitors events: `TimelockQueued`, `TimelockExecuted`, `TimelockCancelled`, `AdminTransferred`, `RouterWhitelisted`, `Paused`, `Unpaused`, `SweepQueued`
   - On any event detection: call `sendTelegramAlert()` with formatted message including:
     - Event name
     - Decoded parameters (actionId, router address, new admin, etc.)
     - Block number and transaction hash
     - Etherscan link
   - `TimelockQueued` alerts should include the `readyAt` timestamp formatted as human-readable date + "Execute window opens in X hours"
   - `AdminTransferred` and `Paused` should be marked as 🔴 CRITICAL in the alert
   - Config via env vars: `ORDER_EXECUTOR_ADDRESS` (already exists), `RPC_URL` (already exists)
   - Exports a `startEventWatcher(client)` function that takes a viem publicClient
   - Graceful error handling: if RPC disconnects, retry with exponential backoff (max 5 retries, then alert and continue)

2. **Integrate event watcher into executor** (`contracts/order-engine/executor/executor.js`):
   - Import and call `startEventWatcher(publicClient)` during executor initialization
   - The watcher runs in parallel with the order execution loop (non-blocking)

3. **Add price guard consecutive block detection** (`src/lib/defillama.ts`):
   - Track consecutive price guard blocks in-memory (Map<tokenPair, { count, firstBlockAt }>)
   - After 3 consecutive blocks for the same token pair within 10 minutes:
     - Log `[PRICE-GUARD] Consecutive blocks detected: ${tokenPair}, count: ${count}`
     - If Vercel KV is available, increment a counter: `price-guard:consecutive:${tokenPair}`
   - Reset counter on successful (non-blocked) validation for that pair

4. **Create alert endpoint** (`src/app/api/internal/alerts/route.ts`):
   - POST endpoint accepting `{ type: 'price-guard-consecutive', tokenPair, count, firstBlockAt }`
   - Protected by `Authorization: Bearer ${INTERNAL_ALERT_SECRET}` header
   - Forwards to Telegram via the same bot token (env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
   - Rate limited: max 1 alert per token pair per 10 minutes

5. **Prometheus metrics** (update `monitor.js`):
   - New counter: `teraswap_executor_admin_events_total{event_type}` — counts each admin event seen
   - New gauge: `teraswap_executor_last_admin_event_timestamp` — Unix timestamp of most recent admin event

**Files affected:** New `contracts/order-engine/executor/event-watcher.js`, update `executor.js` (import + init), update `src/lib/defillama.ts` (consecutive tracking), new `src/app/api/internal/alerts/route.ts`, update `monitor.js` (2 metrics), update `.env.executor.example` (no new vars needed, uses existing)

**Expected output:** All admin events trigger Telegram alerts within 30s. Consecutive price guard blocks (≥3) logged and alerted. Prometheus tracks admin event counts.

**Quality criteria:** `npm run build` passes. Event watcher starts without errors when executor boots. TimelockQueued alert includes human-readable execute window. AdminTransferred marked as CRITICAL. Price guard consecutive counter resets on success. Alert endpoint rate-limited.

---

## PROMPT 18 — Sprint 4: Progressive Timelock & FeeCollector Admin Hardening (R12)

**Context:** The TeraSwapOrderExecutor has a flat 48h timelock for all admin actions (router changes, admin transfer, sweeps). The TeraSwapFeeCollector has NO timelock at all — `setRouter()`, `pause()`, `unpause()`, and `sweep()` are all immediate. The Drift Protocol hack ($285M) showed that admin transfer and security-critical operations need longer timelocks than routine changes.

**Objective:** Implement progressive timelock in the OrderExecutor (different delays per action type) and add basic timelock to the FeeCollector's router management.

**Requirements:**

1. **TeraSwapOrderExecutor — Progressive Timelock:**
   - Replace single `TIMELOCK_DELAY = 48 hours` with action-specific delays:
     ```solidity
     uint256 public constant TIMELOCK_ADMIN_TRANSFER = 7 days;   // R12: highest-impact action
     uint256 public constant TIMELOCK_ROUTER_CHANGE = 48 hours;  // Existing behavior preserved
     uint256 public constant TIMELOCK_SWEEP = 48 hours;          // Existing behavior preserved
     ```
   - Update `queueAdminChange()` to use `TIMELOCK_ADMIN_TRANSFER` instead of `TIMELOCK_DELAY`
   - Update `queueRouterChange()` to use `TIMELOCK_ROUTER_CHANGE`
   - Update `queueSweep()` to use `TIMELOCK_SWEEP`
   - Keep `TIMELOCK_GRACE = 7 days` unchanged
   - Add new constant visibility: `function getTimelockDelays() external pure returns (uint256 adminTransfer, uint256 routerChange, uint256 sweep)`

2. **TeraSwapFeeCollector — Add Router Timelock:**
   - Add timelock mechanism for `setRouter()`:
     ```solidity
     uint256 public constant TIMELOCK_DELAY = 48 hours;
     uint256 public constant TIMELOCK_GRACE = 7 days;

     struct TimelockAction {
         bytes32 actionHash;
         uint256 readyAt;
         bool exists;
     }

     mapping(bytes32 => TimelockAction) public timelockActions;

     event TimelockQueued(bytes32 indexed actionId, bytes32 actionHash, uint256 readyAt);
     event TimelockExecuted(bytes32 indexed actionId);
     event TimelockCancelled(bytes32 indexed actionId);
     ```
   - Replace immediate `setRouter()` with `queueRouterChange()` + `executeRouterChange()`
   - Keep `pause()` and `unpause()` as immediate (emergency functions must not be timelocked)
   - Keep `sweep()` as immediate but add requirement: `require(paused, "Must pause before sweep")` — this is already the case, confirm and document

3. **Update Foundry tests:**
   - Test that admin transfer now requires 7 days (not 48h)
   - Test that router change still works at 48h
   - Test that admin transfer at 48h reverts with `TimelockNotReady`
   - Test FeeCollector router timelock: queue → wait → execute flow
   - Test FeeCollector router timelock: execute before delay reverts
   - Test FeeCollector pause/unpause remain immediate

4. **Update deployment scripts** if they reference `TIMELOCK_DELAY`:
   - Check `deploy.js`, `deploy-sepolia.js`, `bootstrap.js` for hardcoded timelock references
   - The bootstrap function should still work (it's one-time, pre-timelock)

**Files affected:** `contracts/order-engine/TeraSwapOrderExecutor.sol` (constants + queue functions), `contracts/TeraSwapFeeCollector.sol` (add timelock mechanism), Foundry test files, possibly deploy scripts

**Expected output:** Admin transfer requires 7-day wait. Router changes require 48h. FeeCollector router changes now timelocked. Emergency pause remains immediate.

**Quality criteria:** All existing Foundry tests pass. New tests cover progressive delays. `forge test -vvv` shows 7-day admin transfer and 48h router change. FeeCollector timelock queue/execute/cancel works correctly. No breaking changes to existing signed orders (EIP-712 domain unchanged).

---

## PROMPT 21 — Permit2 Phishing Defense UX (R-UX-01)

**Context:** TeraSwap uses Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) for gasless approvals on 0x swaps. The wallet signature UI shows an opaque hash + spender address with no human-readable context. Meanwhile, drainer kits (Inferno, Angel, Pink) weaponize Permit2 in 2025-2026 phishing campaigns — they request signatures with `type(uint48).max` expiration and `uint160.max` amounts, drain victims silently hours/days later. Users who don't understand what a legitimate TeraSwap Permit2 signature looks like cannot distinguish it from phishing.

TeraSwap already has: exact-amount approvals (`src/hooks/useApproval.ts`), a CoW infinite-approval warning in SwapBox (lines 676-688), and `ActiveApprovals.tsx` showing current TeraSwap approvals. What's missing: (1) upfront education the first time a user signs a Permit2 message, (2) a direct entry point to Revoke.cash for approvals outside TeraSwap's scope.

**Objective:** Add two small, complementary UX defenses: a one-time Permit2 education modal before the first signature, and a prominent Revoke.cash link in the approvals surface.

**Requirements:**

1. **Permit2 first-signature modal** — new component `src/components/Permit2EducationModal.tsx`:
   - Triggered when the user is about to sign a Permit2 message AND hasn't dismissed the modal before (persist dismissal in `localStorage` under key `teraswap:permit2-educated:v1`).
   - Hook point: in `src/hooks/useApproval.ts` (or whichever hook/component triggers the Permit2 signTypedData call for 0x), intercept the call. If user hasn't been educated, open the modal and wait for user confirmation before proceeding with `signTypedData`.
   - Modal content (use plain English, no jargon dumps):
     - Title: "About to sign a Permit2 approval"
     - What they're signing: spender = `PERMIT2` contract (`0x000000000022D473030F116dDEE9F6B43aC78BA3`), amount = **exact swap amount** (show the actual number), expiration = **24 hours** (show actual deadline), nonce shown.
     - "How to spot phishing": a short bullet list contrasting legitimate TeraSwap signatures (exact amount, 24h expiration, spender is Permit2 contract) vs phishing (amount = `type(uint160).max`, expiration = `type(uint48).max` ≈ year 8921+, unknown spender).
     - Checkbox: "Don't show this again"
     - Two buttons: "Cancel" and "Continue to signature"
   - Styling: match existing TeraSwap modal patterns in the codebase. Dark mode supported.
   - A "Learn more" link at the bottom pointing to MetaMask's Permit2 phishing article (use a canonical external source — do NOT build an internal docs page).

2. **Revoke.cash link in ActiveApprovals** — modify `src/components/ActiveApprovals.tsx`:
   - Add a footer row/section with the copy: "TeraSwap only shows approvals granted to our contracts. To see Permit2 allowances and approvals granted to other dApps, check Revoke.cash."
   - Button/link: "Open Revoke.cash →" → opens `https://revoke.cash/address/{userAddress}` in a new tab (`rel="noopener noreferrer"`).
   - Only render when wallet is connected (address available).
   - Style consistent with component's existing design language.

3. **Accessibility + i18n:**
   - Modal must be keyboard-dismissible (Esc) and focus-trapped while open.
   - All new strings wrapped in the existing i18n helper if the project already has one (grep for `useTranslation`, `t(`, or `i18next`). If no i18n system exists in the codebase, use plain strings — do NOT introduce a new i18n framework.
   - ARIA: modal has `role="dialog"`, `aria-labelledby`, `aria-modal="true"`.

4. **Tests:**
   - Unit test for the modal component: renders correctly, dismiss persists to localStorage, checkbox toggles state.
   - Integration test (or extend existing tests) for `useApproval` / Permit2 flow: when localStorage flag is unset, modal blocks the signature; when set, signature proceeds immediately.
   - Snapshot or visual test for `ActiveApprovals` showing the new Revoke.cash footer.

5. **Do NOT:**
   - Do NOT create a `/docs` or `/security` page — this was evaluated and rejected (low reach, duplicates canonical external resources).
   - Do NOT change the underlying Permit2 signature parameters (amount, deadline, nonce). They are already correct (exact + 24h); this prompt is UX-only.
   - Do NOT modify CoW approval flow — it already has its own dedicated warning.

**Files affected:** `src/components/Permit2EducationModal.tsx` (new), `src/components/ActiveApprovals.tsx` (edit), `src/hooks/useApproval.ts` (edit hook point), test files accordingly.

**Expected output:** First-time users see an educational modal before their first Permit2 signature that teaches them to recognize legitimate vs phishing signatures. Returning users (flag set) see no interruption. The approvals panel directs users to Revoke.cash for approvals outside TeraSwap's scope.

**Quality criteria:** Modal only shows once per browser (localStorage flag). Signature flow blocks until user confirms. No regression in existing approval tests. Lighthouse accessibility score for the modal ≥ 95. `npm run build` passes. `npm test` passes.
