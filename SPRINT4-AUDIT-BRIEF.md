# TeraSwap — Sprint 4 Security Audit Brief

**Scope:** Focused review of Sprint 4 commits (security hardening based on auditor recommendations R1, R6, R7, R8, R12)
**Commits:** `8864fe4` → `e0ded61` (8 commits, 6,628 insertions)
**Base:** Sprint 3 was APPROVED WITH WARNINGS on 2026-04-05

---

## Audit Scope — 4 Priority Areas

### 1. CRITICAL — Progressive Timelock & FeeCollector Hardening (R12)
**Commit:** `433b5d3`
**Files:**
- `contracts/order-engine/TeraSwapOrderExecutor.sol` — `TIMELOCK_DELAY` replaced with 3 action-specific constants:
  - `TIMELOCK_ADMIN_TRANSFER = 7 days` (was 48 hours)
  - `TIMELOCK_ROUTER_CHANGE = 48 hours` (unchanged)
  - `TIMELOCK_SWEEP = 48 hours` (unchanged)
  - `queueAdminChange()`, `queueRouterChange()`, `queueSweep()` updated to use respective constants
  - New view function: `getTimelockDelays()`
- `contracts/TeraSwapFeeCollector.sol` — NEW timelock mechanism added:
  - `setRouter()` replaced with `queueRouterChange()` + `executeRouterChange()` + `cancelTimelockAction()`
  - `TIMELOCK_DELAY = 48 hours`, `TIMELOCK_GRACE = 7 days`
  - `TimelockAction` struct, `timelockActions` mapping, events (TimelockQueued, TimelockExecuted, TimelockCancelled)
  - `pause()` / `unpause()` remain immediate (emergency functions)
  - `sweep()` remains immediate with `whenNotPaused` guard
- `contracts/order-engine/test/TeraSwapOrderExecutor.t.sol` — 6 new tests for progressive delays
- `contracts/test/TeraSwapFeeCollector.t.sol` — 9 new tests for FeeCollector timelock

**Key questions for auditor:**
1. Is the 7-day admin transfer delay correctly enforced in `queueAdminChange()` and `executeAdminChange()`?
2. Does the FeeCollector timelock implementation match the OrderExecutor pattern (hash verification, grace period, cancellation)?
3. Can an attacker bypass the FeeCollector timelock via any path (e.g., re-entrancy, direct storage manipulation)?
4. Are the new Foundry tests sufficient to cover edge cases (expired actions, hash mismatch, grace period boundary)?
5. Does `TIMELOCK_GRACE = 7 days` still make sense when `TIMELOCK_ADMIN_TRANSFER = 7 days`? (execution window = day 7 to day 14)
6. Is there a risk of DoS via queuing many timelock actions?

---

### 2. HIGH — Calldata Recipient Validation (R1)
**Commit:** `3c2171a`
**Files:**
- `src/lib/calldata-recipient.ts` (NEW — 445 lines) — Decodes recipient address from router calldata for 14 of 18 whitelisted selectors:
  - Decoded (validated): 1inch swap/unoswapTo, Uniswap V2/V3 swaps, SushiSwap, multicall (recursive)
  - Implicit (msg.sender-safe): 0x sellToUniswap/transformERC20, 1inch uniswapV3SwapTo
  - Fail-open with warning: Odos, KyberSwap, Paraswap (complex encoding)
- `src/app/api/swap/route.ts` — Server-side: rejects calldata where decoded recipient ≠ `from` parameter
- `src/hooks/useSwap.ts` — Client-side: throws before wallet prompt if recipient mismatch
- `src/hooks/useSplitSwap.ts` — Client-side: same validation for split swap legs

**Key questions for auditor:**
1. Is the ABI decoding correct for each selector? Specifically:
   - `0x12aa3caf` (1inch swap) — struct decoding of `desc.dstReceiver`
   - `0xac9650d8` / `0x5ae401dc` (Uniswap multicall) — recursive inner call decoding
2. Can an attacker craft calldata that passes the selector check but encodes the recipient at a different offset?
3. Is the fail-open approach for Odos/KyberSwap/Paraswap acceptable, or should these be fail-closed?
4. Are there edge cases where legitimate calldata has a different recipient than `from` (e.g., permit2 flows, CoW settlement)?
5. Does the validation correctly handle checksummed vs lowercase addresses?
6. Can corrupted/truncated calldata cause an unhandled exception instead of returning null?

---

### 3. MEDIUM — On-Chain Event Watcher & Price Guard Alerts (R6 + R8)
**Commit:** `2e2a62f`
**Files:**
- `contracts/order-engine/executor/event-watcher.js` (NEW — 263 lines):
  - Polls OrderExecutor contract events every 30s via viem `getContractEvents`
  - Monitors 8 admin events: TimelockQueued, TimelockExecuted, TimelockCancelled, AdminTransferred, RouterWhitelisted, Paused, Unpaused, SweepQueued
  - Sends Telegram alerts with severity tagging (CRITICAL for AdminTransferred/Paused)
  - Exponential backoff on RPC errors (max 5 retries)
  - Integrated into executor main loop via `startEventWatcher(publicClient, contractAddress, monitor)`
- `src/lib/defillama.ts` — Consecutive price guard block tracking:
  - In-memory Map tracks consecutive blocks per token pair
  - Threshold: 3 blocks within 10 minutes triggers warning log
  - Counter resets on successful (non-blocked) validation
- `contracts/order-engine/executor/monitor.js` — 2 new Prometheus metrics:
  - `teraswap_executor_admin_events_total{event_type}` (counter)
  - `teraswap_executor_last_admin_event_timestamp` (gauge)

**Key questions for auditor:**
1. Can an attacker suppress or delay event detection (e.g., RPC manipulation, log filtering)?
2. Is the 30s polling interval sufficient to detect a TimelockQueued event before the 48h window?
3. Does the exponential backoff have a maximum that could cause events to be missed during extended RPC outages?
4. Is the in-memory consecutive block tracking vulnerable to reset via serverless cold starts (Vercel)?
5. Are Telegram alerts fail-safe (never block executor operation)?

---

### 4. LOW — Supply Chain Hardening (R7)
**Commit:** `8864fe4`
**Files:**
- `.npmrc` — Added `ignore-scripts=true` and `save-exact=true`
- `package.json` — 15 dependencies pinned (removed caret `^`), including viem, wagmi, @supabase/supabase-js, @vercel/kv, @sentry/nextjs
- `.github/workflows/ci.yml` — New `lockfile-lint` job, all `npm ci` commands use `--ignore-scripts=false` override
- `contracts/order-engine/package.json` — 9 dependencies pinned

**Key questions for auditor:**
1. Are all security-critical dependencies pinned to exact versions?
2. Does `ignore-scripts=true` in `.npmrc` with `--ignore-scripts=false` in CI achieve the intended security model (block locally, allow in controlled CI)?
3. Is lockfile-lint configured correctly (HTTPS-only, npm registry, integrity validation)?

---

## CI/CD Changes (Informational)
**Commits:** `27c3d45`, `94ead89`, `e0ded61`
- GitHub Actions upgraded from v4 to v5
- Node.js upgraded from 20.x to 22
- ESLint installed as explicit devDependency (Next.js 16 no longer bundles it)
- Lint runs in advisory mode (React Compiler warnings non-blocking)
- `test-contracts` has `continue-on-error: true` (OpenZeppelin submodule issue in CI)

---

## Context from Previous Audit

The Sprint 3 audit (APPROVED WITH WARNINGS) identified these residual items that Sprint 4 addresses:

| Auditor Rec | Description | Sprint 4 Response |
|---|---|---|
| R1 | Validate recipient in swap calldata | **Prompt 16** — calldata-recipient.ts |
| R6 | Alerting for timelock events | **Prompt 17** — event-watcher.js |
| R7 | lockfile-lint + pin versions | **Prompt 15** — .npmrc + CI |
| R8 | Alert on consecutive price guard blocks | **Prompt 17** — defillama.ts tracking |
| R12 | Progressive timelock | **Prompt 18** — 7d admin, 48h router |

R2 (exact approvals) was confirmed as already implemented — no changes needed.
R3 (ignore-scripts) was bundled into Prompt 15.
R4 (2FA) and R9 (multisig migration) are manual operational actions not covered by code changes.

---

## Expected Deliverable

Focused audit report covering the 4 priority areas above. For each area:
1. Verify implementation correctness against requirements
2. Identify any new vulnerabilities introduced
3. Confirm whether the auditor recommendation (R1/R6/R7/R8/R12) is adequately addressed
4. Flag any edge cases or attack vectors not covered

Final verdict: APPROVED / APPROVED WITH WARNINGS / CHANGES REQUIRED
