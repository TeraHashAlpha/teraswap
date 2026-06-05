# Sprint 23 — Deploy Runbook (Mainnet) + Execution History UI

**Date:** 2026-05-19
**Architect:** Claude (Senior Architect)
**Closes:** Phase 1.5 remaining (execution history per order), deploy preparation
**Branch:** `feat/execution-history-v2` (single branch, single PR)
**Estimated effort:** ~0.5 pw (1 runbook + 1 prompt)

---

## Motivation

Phase 1 is COMPLETE (16/18 B-items closed). Two things remain before TeraSwap can go fully live with conditional orders:

1. **OrderExecutor v2 mainnet deploy** — currently on Sepolia only. Blocked by second YubiKey for Gnosis Safe 2-of-3 multisig, but the deploy runbook can be prepared now so execution is one-click when hardware arrives.

2. **Execution history per order** — the last Phase 1.5 item. `ExecutionTimeline.tsx` exists but is DCA-only and lacks amount formatting, gas display, and aggregate stats. Limit/SL/TP orders show no execution detail at all.

---

## Deliverable A — OrderExecutor v2 Mainnet Deploy Runbook

> **This is NOT a code prompt.** It is a manual runbook for TeraHash to follow when the second YubiKey is available.

### `docs/Runbooks/DEPLOY-ORDER-EXECUTOR-MAINNET.md`

This runbook supersedes the existing `contracts/order-engine/DEPLOYMENT-CHECKLIST.md` (March 2026, pre-Sprint 9B, references FeeCollector V1 and Gelato).

---

#### Pre-requisites

| # | Item | Status |
|---|------|--------|
| 1 | Second YubiKey received + enrolled in Gnosis Safe 2-of-3 | ⬜ Blocked |
| 2 | FeeCollector V2 mainnet confirmed operational (`0x47f2...7459`) | ✅ |
| 3 | All 13 external findings closed (0C/0H) | ✅ |
| 4 | 796 tests passing (TS + Foundry) | ✅ |
| 5 | CI green on `main` | ✅ |
| 6 | Executor wallet funded with ≥0.5 ETH for gas | ⬜ |
| 7 | KMS/Vault configured for executor private key (NOT plaintext) | ⬜ |
| 8 | Flashbots Protect RPC endpoint obtained | ⬜ |

---

#### Step 1 — Deploy Contract

```bash
cd contracts/order-engine

# Set environment
export CHAIN_ID=1
export RPC_URL="https://eth-mainnet.g.alchemy.com/v2/<key>"
export DEPLOYER_PRIVATE_KEY="<gnosis-safe-signer>"

# Constructor args: [FEE_RECIPIENT, ADMIN, WETH]
# FEE_RECIPIENT = 0x107F6eB7C3866c9cEf5860952066e185e9383ABA
# ADMIN = 0x9A387f681a7674F10d255f5b2651EBc4c672C73C (Gnosis Safe)
# WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 (mainnet)

node deploy.js
```

**Output:** `deployment-1.json` with new contract address.

**Verify on Etherscan:**
```bash
# Verify source code (Foundry)
forge verify-contract <ADDRESS> TeraSwapOrderExecutor \
  --chain-id 1 \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
    0x107F6eB7C3866c9cEf5860952066e185e9383ABA \
    0x9A387f681a7674F10d255f5b2651EBc4c672C73C \
    0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2) \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

---

#### Step 2 — Bootstrap Routers

```bash
node bootstrap.js
```

Mainnet routers to whitelist (from `bootstrap.js`):
- `0x111111125421cA6dc452d289314280a0f8842A65` — 1inch v6 AggregationRouter
- `0xDef1C0ded9bec7F1a1670819833240f027b25EfF` — 0x Exchange Proxy
- `0xE592427A0AEce92De3Edee1F18E0157C05861564` — Uniswap V3 SwapRouter
- `0x6A000F20005980200259B80c5102003040001068` — Paraswap Augustus v6

Plus whitelist the executor keeper wallet address.

⚠️ **L-05 active:** Bootstrap rejects EOAs — all addresses must have code (`extcodesize` check).

---

#### Step 3 — Supabase (if not already migrated)

The `orders` and `order_executions` tables should already exist from Sepolia. Verify:
- `chain_id` column exists (default 1)
- RLS policies active
- `order_executions` table has `price_at_execution` column

If new Supabase project for mainnet: run `contracts/order-engine/schema.sql` in SQL Editor.

---

#### Step 4 — Configure Executor Keeper

```bash
cd contracts/order-engine/executor
cp .env.executor.example .env.executor
```

**Critical `.env.executor` values for mainnet:**

```env
CHAIN_ID=1
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/<key>
FLASHBOTS_RPC=https://rpc.flashbots.net

# USE KMS — not plaintext key
# EXECUTOR_PRIVATE_KEY=          ← REMOVE
KMS_KEY_ARN=arn:aws:kms:...      # or VAULT equivalent

ORDER_EXECUTOR_ADDRESS=<from deployment-1.json>
TERASWAP_API_URL=https://teraswap.xyz

# Gas strategy (already calibrated)
GAS_TIER_NORMAL=30
GAS_TIER_ELEVATED=80
GAS_TIER_URGENT=100
PRIORITY_FEE_NORMAL=1.5
PRIORITY_FEE_ELEVATED=2.5
PRIORITY_FEE_URGENT=4
BASE_FEE_MULTIPLIER_NORMAL=2
BASE_FEE_MULTIPLIER_ELEVATED=2.5
BASE_FEE_MULTIPLIER_URGENT=3

# Telegram alerts
TELEGRAM_BOT_TOKEN=<@teraswap_monitor_bot token>
TELEGRAM_CHAT_ID=<chat_id>
```

Start with PM2:
```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
```

---

#### Step 5 — Update Vercel Environment

```
NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS=<from deployment-1.json>
```

No other env changes needed — `SUPABASE_*` and `NEXT_PUBLIC_SUPABASE_*` already set.

---

#### Step 6 — Activate Order Tabs (Code Change Required)

**File:** `src/app/page.tsx`, line 25

```typescript
// BEFORE:
const COMING_SOON_MODES = new Set<SwapMode>(['dca', 'limit', 'sltp'])

// AFTER:
const COMING_SOON_MODES = new Set<SwapMode>([])
```

This removes the "Coming Soon" badges and enables Limit, SL/TP, and DCA tabs.

> ⚠️ This change should be merged ONLY after the OrderExecutor is deployed and executor is running. Package as a separate commit on the deploy branch.

---

#### Step 7 — Verification Checklist

| # | Check | ⬜ |
|---|-------|----|
| 1 | Contract verified on Etherscan | ⬜ |
| 2 | `deployment-1.json` committed | ⬜ |
| 3 | Bootstrap tx confirmed (4 routers + executor whitelisted) | ⬜ |
| 4 | Executor health check responds: `GET /health` | ⬜ |
| 5 | Vercel env updated + redeployed | ⬜ |
| 6 | Create test limit order (small amount, e.g. 0.001 ETH) | ⬜ |
| 7 | Order appears in Supabase `orders` table with `chain_id=1` | ⬜ |
| 8 | Executor detects order (`canExecute` log) | ⬜ |
| 9 | Cancel test order → status updates to `cancelled` | ⬜ |
| 10 | Create DCA order (3 intervals) → verify 3 fills in `order_executions` | ⬜ |
| 11 | Push notification fires on fill (if browser permission granted) | ⬜ |
| 12 | Telegram alert fires on execution | ⬜ |
| 13 | Gas cost < expected (3-tier strategy working) | ⬜ |
| 14 | `COMING_SOON_MODES` emptied + tabs active | ⬜ |
| 15 | Monitor first 24h for any precision loss (M-01 dust check) | ⬜ |

---

#### Rollback

If critical issue found post-deploy:
1. **Pause executor:** `pm2 stop teraswap-executor`
2. **Re-enable Coming Soon:** revert `COMING_SOON_MODES` to `['dca', 'limit', 'sltp']`
3. **Do NOT pause contract** unless funds at risk — admin functions have 48h timelock
4. **Emergency halt:** circuit breaker auto-triggers on 3 consecutive failures

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 134 | Execution history v2 — all order types, formatted amounts, gas, stats | 10 | 2 | 0.9 | 0.35 | 51.4 | P1 |

---

## Prompt 134 — Execution History v2

### Context

`ExecutionTimeline.tsx` (112 lines) displays DCA fill history as a timeline. It fetches from `GET /api/orders/:id/executions` (RLS-authenticated). The component is imported by `OrderDashboard.tsx` but only rendered for DCA orders with `dcaExecuted > 0` (line 372).

**Current limitations:**
- Only shown for DCA orders — Limit/SL/TP orders have no execution detail
- Raw `amount_in` / `amount_out` displayed as strings (no decimal formatting)
- No token symbols shown
- No gas cost in ETH
- No aggregate stats (total filled, average price, total gas)
- `order_executions` table has `price_at_execution` column but component doesn't use it

**Schema (`order_executions`):**
```
id, order_id, created_at, execution_number, tx_hash, amount_in, amount_out,
fee_amount, gas_used, price_at_execution, status (confirmed/failed/pending)
```

**Orders table has:** `token_in_symbol`, `token_out_symbol`, `token_in_decimals`, `token_out_decimals`

### Objective

Enhance `ExecutionTimeline.tsx` to support all order types and display human-readable execution data.

### Requirements

1. **Expand visibility** — Show execution timeline for ALL order types, not just DCA:
   - In `OrderDashboard.tsx`, remove the `isDCA && dcaTotal > 0 && dcaExecuted > 0` guard (line 372)
   - Show for any order that has `status === 'executed'` OR has entries in `order_executions`
   - For single-fill orders (Limit/SL/TP), show one timeline entry

2. **Pass token metadata** — Add props to `ExecutionTimeline`:
   ```typescript
   interface ExecutionTimelineProps {
     orderId: string
     wallet: string
     tokenInSymbol: string
     tokenOutSymbol: string
     tokenInDecimals: number
     tokenOutDecimals: number
   }
   ```
   `OrderDashboard` already has this data in the order object — pass it through.

3. **Format amounts** — Convert raw wei strings to human-readable:
   - Use `viem`'s `formatUnits(BigInt(amount), decimals)` — already available in the project
   - Show as `"0.5 ETH"`, `"1,234.56 USDC"` etc.
   - Use `Intl.NumberFormat` for thousand separators, max 6 decimal places
   - Apply to `amount_in`, `amount_out`, and `fee_amount`

4. **Show gas cost** — Display `gas_used` in human units:
   - Convert to ETH: `formatUnits(BigInt(gasUsed), 18)` (gas is in wei)
   - Show as `"⛽ 0.0023 ETH"` in muted text
   - Only if `gas_used` is not null

5. **Show execution price** — Display `price_at_execution` if available:
   - Chainlink format (8 decimals): `formatUnits(BigInt(price), 8)`
   - Show as `"@ $1,842.50"` below the fill line

6. **Aggregate stats** (DCA orders with 2+ fills):
   - Add a summary bar above the timeline:
     ```
     3/5 fills · 1,500 USDC → 0.82 ETH · Avg $1,829.27 · ⛽ 0.007 ETH
     ```
   - `fills completed / total` from `dca_executed / dca_total` (pass as props)
   - Total `amount_in` and `amount_out` summed across fills
   - Average price = total_out / total_in (in token terms)
   - Total gas summed

7. **Fallback for single-fill orders** — If no `order_executions` rows exist but the order has `status === 'executed'` and `tx_hash` on the order itself:
   - Build a synthetic single entry from the order's `tx_hash`, `amount_out`, `gas_used`, `executed_at`, `executed_price`
   - This handles legacy orders that were executed before `order_executions` tracking existed

8. **API enhancement** — Update `GET /api/orders/:id/executions` route (`src/app/api/orders/[id]/executions/route.ts`):
   - Also return the order's `token_in_symbol`, `token_out_symbol`, `token_in_decimals`, `token_out_decimals`, `dca_total`, `dca_executed` in the response (avoids extra fetch):
     ```json
     {
       "executions": [...],
       "order": {
         "token_in_symbol": "USDC",
         "token_out_symbol": "ETH",
         "token_in_decimals": 6,
         "token_out_decimals": 18,
         "dca_total": 5,
         "dca_executed": 3,
         "tx_hash": "0x...",
         "amount_out": "...",
         "gas_used": "...",
         "executed_at": "...",
         "executed_price": "..."
       }
     }
     ```
   - Keep `wallet` ownership check (security)

9. **Loading skeleton** — Replace the spinner with a pulsing skeleton (3 lines) matching the timeline layout.

### Do NOT

- Do NOT add new dependencies — `viem` and `Intl.NumberFormat` already available
- Do NOT change the `order_executions` schema — read-only enhancement
- Do NOT remove the `wallet` ownership check in the API route
- Do NOT add `useAccount` to `ExecutionTimeline` — wallet comes via props
- Do NOT use `ethers.js` — removed in Sprint 21

### Files affected

| File | Action |
|------|--------|
| `src/components/ExecutionTimeline.tsx` | Major rewrite — formatted amounts, gas, price, stats |
| `src/components/OrderDashboard.tsx` | Remove DCA-only guard (line 372), pass token metadata props |
| `src/app/api/orders/[id]/executions/route.ts` | Return order metadata alongside executions |

### Expected output

1. All 3 files modified
2. `npm run build` passes with zero errors
3. `npm run lint` passes
4. Existing tests still pass (`npm test`)
5. FEEDBACK.md if any edge cases found

### Quality criteria

- Amounts always formatted with correct decimals (6 for USDC, 18 for ETH, etc.)
- No raw wei strings visible in UI
- Graceful fallback: missing `gas_used` → hide gas line, missing `price_at_execution` → hide price
- Single-fill orders (Limit/SL/TP) show execution detail without "fill #1" numbering
- DCA aggregate stats only shown when ≥ 2 fills exist
- Etherscan links use correct domain (mainnet `etherscan.io`, not hardcoded)
- Component renders correctly with 0 executions (returns null)

---

_Sprint 23 deliverables: `docs/Runbooks/DEPLOY-ORDER-EXECUTOR-MAINNET.md` (runbook — supersedes DEPLOYMENT-CHECKLIST.md), `ExecutionTimeline.tsx` (v2), `OrderDashboard.tsx` (expanded timeline visibility), `/api/orders/:id/executions` (enriched response)._
