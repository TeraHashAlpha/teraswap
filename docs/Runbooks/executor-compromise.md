# Executor Compromise Runbook

**Severity:** P0 — Critical  
**Last updated:** 2026-04-17  
**Owner:** Infrastructure Lead  
**Drill schedule:** Quarterly tabletop (next: Q3 2026)

---

## Overview

The TeraSwap executor (keeper) is a whitelisted EOA that calls `executeOrder()` on `TeraSwapOrderExecutor` (`0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`). If its private key is compromised, the attacker can execute orders with manipulated `routerData` — potentially redirecting output tokens.

**Defenses in place:** R1 calldata recipient validation, fail-closed unknown selectors, router whitelist, 48h timelock on `setExecutor`. These reduce blast radius but do NOT eliminate risk from a compromised *existing* executor.

**This runbook is alert-only and manual. Executor removal is always a deliberate, timelocked process.**

---

## 1. Detection Signals

Any ONE of these warrants immediate investigation:

| Signal | Source | Confidence |
|--------|--------|------------|
| Unexpected `OrderExecuted` events (unknown orderHash or unusual routing) | P47 on-chain monitor, Telegram alerts | High |
| Post-execution validation failures (critical severity) | P45 `/api/monitor/validate-execution` | High |
| Executor TX to unknown addresses (not the contract) | Etherscan, manual check | High |
| Executor ETH balance draining (gas theft) | Etherscan, balance alerts | Medium |
| External report (bug bounty, community, security researcher) | Email, Discord, Immunefi | Varies |
| Executor process crash loop or unexpected restart | Server logs, PM2/systemd | Medium |

---

## 2. Immediate Actions (< 5 minutes)

**Goal:** Stop all order execution. Assess later.

### Step 1: Activate kill-switch

Disable the `teraswap_order_engine` source to prevent any new execution attempts from the monitoring system:

```bash
curl -X POST https://teraswap.app/api/admin/kill-switch \
  -H "Authorization: Bearer $KILL_SWITCH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sourceId": "teraswap_order_engine", "reason": "Suspected executor compromise — investigation in progress"}'
```

**Expected response:**
```json
{"success": true, "sourceId": "teraswap_order_engine", "state": "disabled", "reason": "kill-switch-triggered: Suspected executor compromise — investigation in progress"}
```

### Step 2: Verify kill-switch is active

```bash
# Via status API
curl -s https://teraswap.app/api/monitor/status | jq '.sources[] | select(.id == "teraswap_order_engine")'
```

Confirm `"status": "disabled"`. Also verify on the status page: `https://teraswap.app/status`

### Step 3: Stop the executor process

If you have access to the executor server:

```bash
# SSH to executor host
pm2 stop executor    # or: systemctl stop teraswap-executor
```

If no server access: the kill-switch alone prevents the *monitoring system* from triggering execution, but the executor binary runs independently. Stopping it is critical.

### Step 4: Notify the team

Send to the Telegram ops group:

```
INCIDENT: Suspected executor compromise
- Kill-switch activated at [TIME UTC]
- Detection signal: [DESCRIBE WHAT TRIGGERED]
- Executor process: [stopped / cannot access]
- Investigating. DO NOT re-enable until all-clear.
```

### Step 5: Document timestamp and signal

Record in the incident log:
- Exact UTC time of detection
- Which signal triggered the investigation
- Who activated the kill-switch
- Current executor address: check Etherscan

---

## 3. Assessment (5–30 minutes)

**Goal:** Confirm or rule out compromise. Determine blast radius.

### 3a. Check executor TX history

```
https://etherscan.io/address/<EXECUTOR_ADDRESS>
```

Look for:
- Transactions to addresses other than `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` (the contract)
- Unusual gas spending patterns
- ETH transfers out (gas theft)
- Transactions after the executor process was stopped

### 3b. Check executor ETH balance

```
https://etherscan.io/address/<EXECUTOR_ADDRESS>#internaltx
```

If balance is draining via transfers you did not initiate, compromise is confirmed.

### 3c. Compare recent executions against Supabase

Query Supabase for recently executed orders and cross-reference with on-chain events:

```sql
-- Recent executions in the last 24 hours
SELECT
  id,
  wallet,
  order_hash,
  token_in_symbol,
  token_out_symbol,
  amount_in,
  amount_out,
  tx_hash,
  executed_at,
  router
FROM orders
WHERE status = 'executed'
  AND executed_at > now() - interval '24 hours'
ORDER BY executed_at DESC
LIMIT 50;
```

For each execution, verify on Etherscan:
- Was the `tx_hash` actually mined?
- Did the output go to the `wallet` (order owner)?
- Was the `router` the one in the signed order?

### 3d. Check P45 validation results

```bash
# Check KV for recent validation failures
# (Requires admin KV access or Upstash dashboard)
# Key pattern: teraswap:execution-audit:0x<txhash>
```

Any `severity: "critical"` results in the last 24h are strong indicators.

### 3e. Decision point

| Finding | Conclusion | Next step |
|---------|-----------|-----------|
| No anomalous TXs, executor balance stable, all outputs correct | **False alarm** | Go to Section 6 (Stand-down) |
| Anomalous TXs from executor, but no fund loss | **Likely compromise, contained** | Go to Section 4 (Containment) |
| Fund loss confirmed (output redirected) | **Confirmed compromise** | Go to Section 4, then Section 5 |

---

## 4. Containment (30 minutes – 2 hours)

**Goal:** Revoke the compromised executor. Deploy replacement.

### 4a. Propose executor removal (48h timelock)

Call `proposeExecutorChange(address, false)` on the contract. This starts the 48h timelock.

```bash
# Using cast (Foundry)
cast send 0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130 \
  "proposeExecutorChange(address,bool)" \
  <COMPROMISED_EXECUTOR_ADDRESS> false \
  --rpc-url $RPC_URL \
  --private-key $ADMIN_PRIVATE_KEY
```

**Record the TX hash.** The `ExecutorChangeProposed` event will be picked up by P47 on-chain monitor.

### 4b. Generate new executor keypair

On an isolated, clean machine (NOT the compromised host):

```bash
# Generate new keypair
cast wallet new

# Record the address and private key securely
# Store the private key in AWS KMS or equivalent HSM
```

### 4c. Propose new executor addition

```bash
cast send 0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130 \
  "proposeExecutorChange(address,bool)" \
  <NEW_EXECUTOR_ADDRESS> true \
  --rpc-url $RPC_URL \
  --private-key $ADMIN_PRIVATE_KEY
```

### 4d. Notify affected users

If any open orders exist that could be at risk:

```sql
-- Count active orders
SELECT COUNT(*) FROM orders WHERE status = 'active';
```

If > 0: consider notifying users to cancel their orders via the UI. The contract's `cancelOrder()` function is callable by the order owner at any time.

### 4e. If timelock is too slow (active drain in progress)

The 48h timelock cannot be bypassed by design (SC-H-01). If the attacker is actively executing orders with bad routing:

1. **The kill-switch prevents new triggering** from our monitoring system
2. **The executor process is stopped** (Step 2.3)
3. **But the compromised key can still call the contract directly**

Emergency measures if the attacker is calling `executeOrder()` directly:
- Notify users with active orders to cancel immediately (Telegram broadcast, UI banner)
- Contact whitelisted router teams (1inch, 0x, ParaSwap, Uniswap) to flag the executor address
- If legal threshold met ($100K+ loss): engage legal counsel and law enforcement

---

## 5. Recovery (After 48h timelock)

### 5a. Execute both proposals

```bash
# Remove compromised executor
cast send 0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130 \
  "executeExecutorChange(address,bool)" \
  <COMPROMISED_EXECUTOR_ADDRESS> false \
  --rpc-url $RPC_URL \
  --private-key $ADMIN_PRIVATE_KEY

# Add new executor
cast send 0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130 \
  "executeExecutorChange(address,bool)" \
  <NEW_EXECUTOR_ADDRESS> true \
  --rpc-url $RPC_URL \
  --private-key $ADMIN_PRIVATE_KEY
```

### 5b. Deploy new executor process

1. Set up new executor on clean infrastructure
2. Configure with new private key (from 4b)
3. Update `EXECUTOR_PRIVATE_KEY` in the executor's `.env.executor`
4. Start the process: `pm2 start executor.js --name executor`

### 5c. Verify with a test order

Create a small test order ($10 equivalent) and verify:
- Executor picks it up within the polling interval
- Order executes successfully
- Output goes to the correct wallet
- P45 post-execution validation returns `severity: "ok"`

### 5d. Re-enable the source

The kill-switch P0 designation blocks auto-recovery. Manual re-activation is required:

> **Note:** There is intentionally no re-activation API endpoint. Re-activation requires a code deployment or direct KV manipulation — this friction is by design.

### 5e. Rotate shared secrets

Update these in Vercel environment variables:
- `EXECUTOR_VALIDATION_SECRET` — used by P45 post-execution validation
- Any shared secrets between the executor and the API

### 5f. Publish post-mortem

Within 72 hours, publish a post-mortem covering:
- Timeline (detection → containment → recovery)
- Root cause (how was the key compromised?)
- Impact (orders affected, funds lost/at-risk)
- Remediation (what changed to prevent recurrence)
- Detection improvements (did monitoring catch it? how fast?)

---

## 6. Stand-down (False Alarm)

If assessment (Section 3) concludes no compromise:

1. Document the false alarm and what triggered it
2. Deactivate kill-switch (requires manual KV write or code deploy)
3. Restart executor process
4. Notify team: all-clear with brief explanation
5. Consider: should the detection signal be tuned to reduce false positives?

---

## Contact List

| Role | Name | Contact | When to notify |
|------|------|---------|----------------|
| Founder / Admin key holder | _[NAME]_ | _[PHONE/TELEGRAM]_ | Immediately (Step 2.4) |
| Infrastructure Lead | _[NAME]_ | _[PHONE/TELEGRAM]_ | Immediately |
| Security Auditor | _[FIRM]_ | _[EMAIL]_ | During assessment (Step 3) |
| Legal Counsel | _[FIRM]_ | _[EMAIL]_ | If fund loss confirmed (Step 4e) |

> **Fill in contact details and store securely. Do NOT commit real phone numbers or emails.**

---

## Key Addresses

| Contract / Account | Address | Etherscan |
|-------------------|---------|-----------|
| TeraSwapOrderExecutor | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` | [Link](https://etherscan.io/address/0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130) |
| TeraSwapFeeCollector | `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD` | [Link](https://etherscan.io/address/0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD) |
| Fee Recipient | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` | [Link](https://etherscan.io/address/0x107F6eB7C3866c9cEf5860952066e185e9383ABA) |
| Executor (current) | _Check `.env.executor` — do NOT commit here_ | — |

---

## Drill Schedule

**Frequency:** Quarterly tabletop exercise (no live transactions).

**Format:** Walk through the decision tree with a simulated scenario. Each team member takes their assigned role and executes their steps (using testnet or dry-run commands).

**Scenarios to rotate:**
1. P47 on-chain monitor detects unexpected `ExecutorChangeProposed` event
2. P45 validation returns `critical` on 3 consecutive orders from one source
3. External researcher reports executor address sending ETH to unknown wallet
4. Executor process logs show authentication failures from unknown IP

**Record:** Date, participants, scenario, time-to-containment, lessons learned.

| Quarter | Date | Scenario | Participants | Notes |
|---------|------|----------|-------------|-------|
| Q3 2026 | TBD | _#1 or #2_ | _All_ | — |
