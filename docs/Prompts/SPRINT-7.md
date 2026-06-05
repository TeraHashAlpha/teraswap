# Sprint 7 — Forensic & Post-Execution Security

**Sprint window:** 2026-04-17 → 2026-04-17 (COMPLETE + APPROVED 2026-04-21)
**Sprint goal:** Close the forensic and post-execution security gaps identified by the auditor. Add last-line-of-defense validation, mass-failure detection, on-chain event monitoring, and incident response tooling.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 6D COMPLETE + APPROVED.
**Threat model:** Rhea Finance exploit (April 2026) — $7.6M drained via margin validation bypass. Pre-trade validation without post-trade enforcement. Validates P45 as critical.

---

## Auditor-identified gaps (prioritized)

| Gap ID | Description | RICE Score | Sprint 7 Prompt |
|--------|------------|------------|-----------------|
| P45 | Post-execution balance validation | R:10 I:10 C:9 E:3 = **30** | Prompt 54 (FIRST) |
| P46 | Automated circuit breaker | R:8 I:9 C:8 E:2 = **28.8** | Prompt 55 |
| P47 | On-chain event monitoring | R:7 I:8 C:7 E:3 = **13.1** | Prompt 56 |
| P48 | Executor compromise runbook | R:6 I:9 C:9 E:1 = **48.6** | Prompt 57 |
| P49 | TxAnalyzer forensic skill | R:5 I:7 C:6 E:2 = **10.5** | Prompt 58 |

**Note:** P48 has highest RICE (low effort, high impact) but P45 is prioritized due to real-world exploit validation (Rhea Finance). P48 is a runbook (documentation), not code — quickest to produce.

---

## Sprint status table

| # | Prompt | Gap | Priority | Status |
|---|--------|-----|----------|--------|
| 54 | Post-execution balance validation | P45 | CRITICAL | ✅ `627ba0f` — 36 tests |
| 55 | Automated circuit breaker | P46 | HIGH | ✅ `603f24b` — 19 tests |
| 56 | On-chain event monitoring | P47 | MEDIUM | ✅ `d46190f` — 29 tests |
| 57 | Executor compromise runbook | P48 | HIGH | ✅ `fa4c6ef` — runbook |
| 58 | TxAnalyzer forensic skill | P49 | MEDIUM | ✅ `8d724f2` — 6 files, 1312 lines |

---

## Prompt 54 — Post-execution balance validation (P45)

**Status:** Pending.

**Context:** The Rhea Finance exploit (April 2026, $7.6M) proved that pre-trade validation without post-trade enforcement is a critical vulnerability. Rhea's Burrowland validated a `min_amount_out` of 32.5T but received 7,925 — a 4.1M× discrepancy — and accepted the result without revalidation.

TeraSwap's smart contract (`TeraSwapOrderExecutor.sol`) already performs pre-execution `balanceOf` checks (line 473) and tracks output balance deltas with BEFORE snapshots (lines 493, 516). However, there is **no off-chain post-execution validation** in the monitoring system. If a swap executes on-chain but produces an unexpected output (due to a bug, manipulation, or edge case), no alert is generated and no monitoring catches it.

**Objective:** Add post-execution balance validation to the monitoring system that compares actual swap results against expected minimums, alerting operators on significant discrepancies.

**Requirements:**

1. **Create `src/lib/post-execution-validator.ts`** — a utility that validates transaction receipts against expected outcomes:
   ```typescript
   export interface ExecutionValidation {
     txHash: string
     orderId: string
     tokenOut: string
     expectedMinimum: bigint    // from order's minAmountOut
     actualReceived: bigint     // from balanceOf delta or Transfer event
     discrepancyPercent: number // ((expected - actual) / expected) * 100
     status: 'ok' | 'warning' | 'critical'
     timestamp: number
   }

   /**
    * Validate a completed order execution against expected output.
    * - ok: actual >= expectedMinimum
    * - warning: actual < expectedMinimum but within 2% (slippage edge)
    * - critical: actual < expectedMinimum by >2% (potential exploit or bug)
    */
   export async function validateExecution(
     txHash: string,
     orderId: string,
     tokenOut: string,
     expectedMinimum: bigint,
     rpcUrl: string,
   ): Promise<ExecutionValidation>
   ```

2. **Read actual output from TX receipt** — two strategies (use both, prefer events):
   - **Primary:** Parse `Transfer` events from the TX receipt logs. Filter by `tokenOut` address and `to` matching the order owner. Sum all matching transfers.
   - **Fallback:** If Transfer events are ambiguous (multiple transfers, complex routing), call `balanceOf(owner)` at block N (post-TX) and compare against stored pre-TX balance.

3. **Integration point — post-execution hook:** The executor (external keeper) calls `executeOrder()` on the contract. After TX confirmation, the keeper or a monitoring process should call `validateExecution()`. Since the keeper is external and not in our codebase, add this validation to:
   - **Option A (recommended):** A new API route `POST /api/monitor/validate-execution` that the keeper calls after each TX with `{ txHash, orderId, tokenOut, expectedMinimum }`. The route validates and alerts.
   - **Option B:** A periodic scan in the monitoring tick that reads recent `OrderExecuted` events from the contract and validates each.
   - Implement **Option A** (on-demand validation, lowest latency). Document Option B for future enhancement.

4. **Alert thresholds:**
   - `ok`: actual >= expected — log only, no alert
   - `warning`: actual < expected by 0-2% — log + Telegram INFO alert (slippage edge cases)
   - `critical`: actual < expected by >2% — P0 alert via full fan-out (Telegram + Email + Discord), auto-disable the source that routed the swap, log to KV audit trail

5. **KV audit trail:** Store validation results in KV:
   ```
   teraswap:execution-validation:{txHash} → { orderId, tokenOut, expected, actual, discrepancy%, status, timestamp }
   ```
   TTL: 7 days (enough for forensic review).

6. **Auth:** The `/api/monitor/validate-execution` route must require Bearer auth (use the shared `verifyBearerToken` from `src/lib/auth.ts`) with a new env var `EXECUTOR_VALIDATION_SECRET`.

7. **Graceful degradation:** If RPC is unreachable for receipt/balanceOf, log the failure and return `status: 'unknown'` — do NOT block the executor. Validation is advisory, not blocking.

**Files affected:**
- `src/lib/post-execution-validator.ts` (new)
- `src/app/api/monitor/validate-execution/route.ts` (new)
- `src/lib/alert-wrapper.ts` (add critical execution alert type if needed)

**Do NOT:**
- Do NOT modify the smart contract — this is off-chain monitoring only.
- Do NOT block order execution if validation fails — it's a monitoring/alerting layer.
- Do NOT hardcode RPC URLs — use the existing RPC configuration.
- Do NOT duplicate the alert fan-out logic — use existing `emitTransitionAlert()` or similar.
- Do NOT add the periodic scan (Option B) in this prompt — document for future Sprint.

**Quality criteria:**
- Test: TX receipt with expected output → `status: 'ok'`
- Test: TX receipt with output 1% below expected → `status: 'warning'`
- Test: TX receipt with output 5% below expected → `status: 'critical'`, alert triggered
- Test: RPC failure → `status: 'unknown'`, no crash
- Test: API route requires auth, rejects unauthenticated requests
- Test: KV audit trail written with correct TTL
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 55 — Automated circuit breaker (P46)

**Status:** Pending.

**Context:** The source state machine allows all 11 sources to transition independently to `disabled` with no collective safeguard. If a systemic event (RPC provider outage, Vercel region failure, or coordinated attack) disables 6+ sources within a short window, the aggregator continues operating with reduced liquidity and degraded routing quality — but no alarm distinguishes this from individual source failures.

Currently, each source disable generates its own alert. But 6 individual "source disabled" alerts don't convey the same urgency as "majority of sources down — systemic event." The quorum check (H5) catches price outliers but not availability collapse.

**Objective:** Add an automated circuit breaker that detects mass source disablement and triggers a systemic P0 alert.

**Requirements:**

1. **Create `src/lib/circuit-breaker.ts`** — evaluates aggregate source health:
   ```typescript
   export interface CircuitBreakerResult {
     triggered: boolean
     disabledCount: number
     totalSources: number
     disabledSources: string[]
     triggerReason?: string
   }

   /**
    * Check if the circuit breaker should trip.
    * Conditions:
    * - ≥6 of 11 sources disabled (majority)
    * - OR ≥4 sources disabled within a 10-minute window (rapid cascade)
    */
   export function evaluateCircuitBreaker(
     sourceStates: Map<string, SourceState>,
   ): CircuitBreakerResult
   ```

2. **Two trigger conditions:**
   - **Majority disabled:** ≥6 of total sources (>50%) currently in `disabled` state — regardless of timing.
   - **Rapid cascade:** ≥4 sources transitioned to `disabled` within the last 10 minutes — even if total disabled is <6. This catches the early phase of a cascading failure.

3. **Integration in monitoring tick:** After state transitions are processed in `runMonitoringTick()`, call `evaluateCircuitBreaker()`. If triggered:
   - Send a **systemic P0 alert** via full fan-out: `"🚨 CIRCUIT BREAKER: {disabledCount}/{totalSources} sources disabled — {triggerReason}"`
   - Log to KV: `teraswap:circuit-breaker:last-trip → { timestamp, disabledCount, sources[], reason }`
   - The alert is distinct from individual source alerts — it signals a systemic event requiring immediate operator attention.

4. **No automatic routing pause** (yet) — the circuit breaker is an alert-only mechanism in this sprint. Automatic routing pause (halt all swaps) is a dangerous feature that requires careful design with manual override. Document it as a future enhancement.

5. **Cooldown:** After triggering, do not re-trigger for 15 minutes (prevent alert storm during prolonged outage). Use KV to track last trip timestamp.

6. **Configuration:** Thresholds should be configurable via `data/source-thresholds.json` or constants:
   ```typescript
   const CIRCUIT_BREAKER_MAJORITY_THRESHOLD = 6  // ≥6 disabled = trip
   const CIRCUIT_BREAKER_CASCADE_THRESHOLD = 4   // ≥4 disabled in window = trip
   const CIRCUIT_BREAKER_CASCADE_WINDOW_MS = 10 * 60 * 1000  // 10 minutes
   const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000  // 15 minutes
   ```

**Files affected:**
- `src/lib/circuit-breaker.ts` (new)
- `src/lib/monitoring-loop.ts` (add circuit breaker evaluation after state transitions)

**Do NOT:**
- Do NOT automatically pause routing or disable the aggregator — alert only.
- Do NOT change individual source state transitions — circuit breaker is an aggregate check, not a per-source override.
- Do NOT send circuit breaker alerts through the per-source dedup system — it's a separate alert type.
- Do NOT trigger on degraded sources — only disabled sources count.

**Quality criteria:**
- Test: 5 disabled → not triggered. 6 disabled → triggered (majority).
- Test: 4 disabled within 10min → triggered (rapid cascade). 4 disabled over 30min → not triggered.
- Test: After trigger, no re-trigger for 15 minutes (cooldown).
- Test: Alert message includes disabled count, total, and source list.
- Test: KV audit trail written on trip.
- Integration test: monitoring tick with 6 disabled sources → circuit breaker fires.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 56 — On-chain event monitoring (P47)

**Status:** Pending.

**Context:** TeraSwap's smart contracts (`TeraSwapFeeCollector` and `TeraSwapOrderExecutor`) emit events for critical operations (order execution, fee collection, executor changes, timelock proposals). These events are the authoritative on-chain record of what happened. Currently, the monitoring system checks source health (HTTP endpoints) but does NOT monitor on-chain events. If an unexpected `setExecutor` proposal is submitted, or orders execute with unusual parameters, no alert is generated.

The RPC proxy already whitelists `eth_getLogs` (line 27 of `/api/rpc/route.ts`), so the infrastructure exists.

**Objective:** Add on-chain event monitoring that watches for critical contract events and alerts operators on anomalies.

**Requirements:**

1. **Create `src/lib/on-chain-monitor.ts`** — listens for events from both contracts:
   ```typescript
   export interface OnChainEvent {
     contract: 'FeeCollector' | 'OrderExecutor'
     eventName: string
     txHash: string
     blockNumber: number
     args: Record<string, unknown>
     severity: 'info' | 'warning' | 'critical'
   }

   /**
    * Fetch and categorize events from the last N blocks.
    * Uses eth_getLogs with contract address + topic filters.
    */
   export async function scanContractEvents(
     fromBlock: number,
     toBlock: number,
     rpcUrl: string,
   ): Promise<OnChainEvent[]>
   ```

2. **Events to monitor:**

   **OrderExecutor — INFO (operational logging):**
   - `OrderExecuted(bytes32 indexed orderHash, address indexed executor, ...)` — log all executions
   - `OrderCancelled(bytes32 indexed orderHash, address indexed owner)` — log cancellations

   **OrderExecutor — CRITICAL (admin operations):**
   - `ExecutorProposed(address indexed executor, uint256 executeAfter)` — timelock proposal
   - `ExecutorChanged(address indexed executor, bool whitelisted)` — executor whitelist change
   - `RouterUpdated(address indexed router, bool whitelisted)` — router whitelist change
   - `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` — ownership change

   **FeeCollector — WARNING:**
   - `FeesCollected(address indexed token, uint256 amount)` — large fee collection (>1 ETH equivalent)
   - `FeesSweep(address indexed token, address indexed to, uint256 amount)` — any sweep operation

   **FeeCollector — CRITICAL:**
   - `OwnershipTransferred(...)` — ownership change

3. **Integration in monitoring tick:** Add on-chain scan as a periodic check (every 5th tick, same cadence as quorum). Read the last scanned block from KV (`teraswap:onchain:last-block`), scan from there to current block.

4. **Alert routing:**
   - INFO events: log to KV only (no Telegram alert)
   - WARNING events: Telegram alert (no buttons, no fan-out)
   - CRITICAL events: P0 alert via full fan-out — admin operations on contracts should always trigger immediate operator notification

5. **RPC usage:** Use the project's existing RPC configuration (Infura/Alchemy/public nodes). Do NOT route through the RPC proxy (that's for frontend users). Import the RPC URL from env vars directly.

6. **Block range safety:** Limit scan to max 1000 blocks per tick (prevent RPC timeout on long gaps). If gap > 1000 blocks, scan in chunks across multiple ticks, advancing `last-block` progressively.

**Files affected:**
- `src/lib/on-chain-monitor.ts` (new)
- `src/lib/monitoring-loop.ts` (add on-chain scan to tick, every 5th tick)
- Contract ABIs: extract event signatures from existing contract artifacts or hardcode topic hashes

**Do NOT:**
- Do NOT use WebSocket subscriptions — use polling via `eth_getLogs` (compatible with serverless).
- Do NOT route RPC calls through the frontend proxy.
- Do NOT scan every tick — every 5th tick is sufficient (once every 5 minutes).
- Do NOT store full event data in KV long-term — store only the last scanned block number and recent critical events (7-day TTL).

**Quality criteria:**
- Test: OrderExecuted event parsed correctly with all args.
- Test: ExecutorProposed event → severity 'critical'.
- Test: FeesCollected below threshold → severity 'info'. Above threshold → 'warning'.
- Test: OwnershipTransferred → severity 'critical', P0 alert.
- Test: Block range > 1000 → chunked scan.
- Test: RPC failure → graceful skip, last-block not advanced.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 57 — Executor compromise runbook (P48)

**Status:** Pending.

**Context:** The TeraSwap executor (keeper) is a whitelisted external account that calls `executeOrder()` on the smart contract. If an executor's private key is compromised, the attacker can execute orders with manipulated routing (sending output to a different address via crafted `routerData`). The 48h timelock on `setExecutor` (SC-H-01, fixed in `9dc383d`) prevents instant executor additions, but a compromised EXISTING executor is already whitelisted.

Defenses in place: R1 calldata validation (recipient check), fail-closed for unknown selectors (API-M-02), router whitelist. But there's no documented procedure for what to do if compromise is suspected.

**Objective:** Create an executable runbook for suspected executor compromise.

**Requirements:**

1. **Create `docs/Runbooks/executor-compromise.md`** — a decision tree with clear steps:

   **Detection signals:**
   - Unexpected `OrderExecuted` events (from on-chain monitor, Prompt 56)
   - Transactions from executor to unknown addresses
   - Executor account balance draining (gas theft)
   - Post-execution validation failures (Prompt 54)
   - External report (bug bounty, community alert)

   **Immediate actions (< 5 minutes):**
   - Step 1: Activate kill-switch (`POST /api/admin/kill-switch` with Bearer token)
   - Step 2: Verify kill-switch active via `/status` page or Telegram `/status`
   - Step 3: Notify team via Telegram group
   - Step 4: Document the detection signal and timestamp

   **Assessment (5-30 minutes):**
   - Check executor TX history on Etherscan (link template with executor address)
   - Compare recent `OrderExecuted` events against expected orders in Supabase
   - Check if any orders executed with unexpected routing (recipient ≠ order owner)
   - Check executor ETH balance for unauthorized transfers

   **Containment (30 minutes - 2 hours):**
   - If confirmed compromise: propose executor removal via `proposeExecutor(address, false)` — starts 48h timelock
   - Deploy new executor with fresh keypair on isolated infrastructure
   - Propose new executor addition via `proposeExecutor(newAddress, true)`
   - If timelock is too slow (active drain): emergency measures — contact users with affected open orders to cancel

   **Recovery:**
   - After 48h: execute both proposals (remove compromised, add new)
   - Re-enable kill-switch
   - Verify new executor processes a test order correctly
   - Update EXECUTOR_VALIDATION_SECRET and any shared secrets
   - Publish post-mortem (template in `docs/Runbooks/post-mortem-template.md`)

   **Drill schedule:** Quarterly tabletop exercise (no live TX). Walk through the decision tree with a simulated compromise scenario.

2. **Include command templates** — exact curl commands for kill-switch, exact Etherscan URL patterns, exact Supabase query to check recent orders.

3. **Include a contact list placeholder** — who to notify (founder, auditor, legal if funds lost).

**Files affected:**
- `docs/Runbooks/executor-compromise.md` (new)

**Do NOT:**
- Do NOT include actual secrets, API keys, or private keys in the runbook.
- Do NOT automate executor removal — this is a manual, deliberate process via timelock.
- Do NOT include smart contract code changes — this is a procedure document.

**Quality criteria:**
- Decision tree is unambiguous: each step has a clear outcome leading to the next step.
- Command templates are copy-paste ready (with placeholder variables).
- Time targets are realistic (< 5min, 5-30min, 30min-2h).
- Drill schedule documented.
- Reviewed by auditor as part of Sprint 7 audit.

---

## Prompt 58 — TxAnalyzer forensic skill (P49)

**Status:** Pending.

**Context:** When a DeFi exploit or suspicious transaction is detected, forensic analysis requires decoding transaction traces, identifying fund flows, and mapping attack patterns. This is currently manual — the analyst reads Etherscan, decodes calldata by hand, and traces funds through block explorers.

TxAnalyzer (by BradMoon) is an open-source AI exploit analyzer that can be integrated as a Claude Code skill. It automates: TX receipt decoding, internal call trace analysis, fund flow mapping, and pattern matching against known exploit techniques.

**Objective:** Integrate TxAnalyzer as a forensic analysis skill that operators can invoke when investigating suspicious transactions.

**Requirements:**

1. **Create `skills/tx-analyzer/SKILL.md`** — a Claude Code skill that:
   - Accepts a transaction hash as input
   - Fetches the TX receipt and internal traces via RPC
   - Decodes all function calls using known ABIs (TeraSwap contracts + common DeFi protocols)
   - Maps fund flows: which addresses received tokens, in what amounts
   - Identifies patterns: flash loans, recursive calls, unusual approval chains, price manipulation sequences
   - Outputs a structured analysis report

2. **Skill structure:**
   ```
   skills/tx-analyzer/
   ├── SKILL.md          # Skill definition with instructions
   ├── prompts/
   │   ├── analyze-tx.md    # Main analysis prompt template
   │   └── fund-flow.md     # Fund flow tracing prompt
   └── abis/
       ├── TeraSwapOrderExecutor.json
       ├── TeraSwapFeeCollector.json
       └── common-defi.json    # ERC20, Uniswap, etc.
   ```

3. **SKILL.md should instruct the AI to:**
   - Use `cast` (Foundry) or direct RPC calls to fetch TX data
   - Decode logs using the provided ABIs
   - Identify the sequence of operations (approval → transfer → swap → transfer)
   - Flag anomalies: unexpected recipients, unusual amounts, reentrant calls, flash loan patterns
   - Generate a markdown report with: summary, timeline, fund flow diagram (mermaid), risk assessment

4. **ABI extraction:** Export the relevant event and function ABIs from the existing contract artifacts in `contracts/`. Don't include the full ABI — only the events and key functions needed for forensic analysis.

5. **Integration:** The skill is invoked manually by the operator (not automated). It's a forensic tool for post-incident analysis, not a real-time monitor.

**Files affected:**
- `skills/tx-analyzer/SKILL.md` (new)
- `skills/tx-analyzer/prompts/analyze-tx.md` (new)
- `skills/tx-analyzer/prompts/fund-flow.md` (new)
- `skills/tx-analyzer/abis/` (new — extracted from contract artifacts)

**Do NOT:**
- Do NOT make this an automated/scheduled process — it's an on-demand forensic tool.
- Do NOT include private keys or secrets in the skill.
- Do NOT depend on external services (APIs, databases) — use only RPC and local ABIs.
- Do NOT install TxAnalyzer as a dependency — create a self-contained skill inspired by its approach.

**Quality criteria:**
- Skill can be invoked with a TX hash and produces a structured analysis.
- ABI files cover TeraSwap contracts + common ERC20/DEX interfaces.
- Fund flow output identifies sender, receiver, token, amount for each transfer.
- Anomaly detection flags at least: unexpected recipient, flash loan pattern, reentrant call.
- SKILL.md is clear enough for any operator to invoke without prior training.

---

## Auditor review — Sprint 7

**Scope:** Review all changes from Prompts 54-58.

**Checklist:**

1. **P45 (post-execution validation):**
   - [ ] `validateExecution()` correctly parses Transfer events from TX receipt
   - [ ] Discrepancy thresholds: ok (≥expected), warning (<2%), critical (>2%)
   - [ ] Critical discrepancy → P0 alert via full fan-out
   - [ ] API route requires Bearer auth
   - [ ] KV audit trail with 7-day TTL
   - [ ] RPC failure → graceful `status: 'unknown'`, no crash
   - [ ] Executor not blocked on validation failure

2. **P46 (circuit breaker):**
   - [ ] Majority trigger: ≥6/11 disabled
   - [ ] Cascade trigger: ≥4 disabled within 10min
   - [ ] 15min cooldown prevents alert storm
   - [ ] Alert-only — no automatic routing pause
   - [ ] KV audit trail on trip

3. **P47 (on-chain events):**
   - [ ] Correct event topic hashes for both contracts
   - [ ] Severity classification matches requirements (admin ops = critical)
   - [ ] Block range limited to 1000 per scan
   - [ ] RPC failure → graceful skip
   - [ ] Every 5th tick cadence

4. **P48 (executor runbook):**
   - [ ] Decision tree is unambiguous
   - [ ] Time targets are realistic
   - [ ] No secrets in runbook
   - [ ] Command templates are copy-paste ready
   - [ ] Drill schedule documented

5. **P49 (TxAnalyzer skill):**
   - [ ] Skill invokable with TX hash
   - [ ] ABIs cover TeraSwap contracts + common DeFi
   - [ ] Fund flow identifies sender/receiver/token/amount
   - [ ] Anomaly flags: unexpected recipient, flash loan, reentrancy
   - [ ] No external dependencies beyond RPC

**Expected output:** Findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

### Auditor verdict (2026-04-21): ✅ APPROVED

Zero security findings. 4 INFO/NOTE observations (cosmetics/good practice). 84 new tests (36 + 19 + 29). Rhea Finance threat model validated — P45 covers pre-trade-without-post-trade pattern. Shortfall >2% → auto-disable + P0 alert. Validator is advisory only (never blocks executor). Integration into monitoring loop correct. Auth pattern consistent with Sprint 6C.

---

## See also

- Sprint 6D: `docs/Prompts/SPRINT-6D.md` — Prerequisite
- Sprint 6C: `docs/Prompts/SPRINT-6C.md` — COMPLETE + APPROVED
- Rhea Finance exploit analysis: `.auto-memory/reference_defi_hacks_rhea_finance.md`
- TxAnalyzer reference: `.auto-memory/reference_txanalyzer_tool.md`
- Comprehensive audit: `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx`
