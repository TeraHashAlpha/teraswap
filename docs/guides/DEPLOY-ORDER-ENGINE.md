# TeraSwap Order Engine — Deployment Guide

## Prerequisites

- Deployer wallet with ETH (Sepolia for testnet, mainnet for production)
- [Supabase](https://supabase.com) project (free tier works)
- Node.js 18+
- A server/VPS for the executor (or run locally for testnet)

---

## Step 1 — Deploy Smart Contract

```bash
cd contracts/order-engine

# Install contract dependencies (if not already done)
npm install

# Compile (creates build/TeraSwapOrderExecutor.abi.json + .bin)
node compile.js

# Deploy to Sepolia testnet
PRIVATE_KEY=0xYOUR_DEPLOYER_KEY \
RPC_URL=https://ethereum-sepolia.publicnode.com \
node deploy.js

# For mainnet:
# PRIVATE_KEY=0x... RPC_URL=https://eth.llamarpc.com CHAIN_ID=1 node deploy.js
```

The deploy script will output the contract address. Save it.

---

## Step 2 — Set Up Supabase

1. Go to your Supabase project → **SQL Editor**
2. Paste the contents of `contracts/order-engine/schema.sql`
3. Click **Run**

This creates:
- `orders` table (all order types: limit, stop_loss, dca)
- `order_executions` table (DCA fill history)
- Row Level Security policies
- Rate limiting function
- Wallet normalization triggers
- Indexes for fast queries

**Enable Realtime** for the `orders` table:
1. Go to **Database** → **Replication**
2. Enable replication for the `orders` table
3. This lets the frontend receive live order status updates

---

## Step 3 — Configure Environment Variables

Add to `.env.local`:

```env
# ── Supabase ──────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Server-side (API routes) — use the service role key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# ── Order Engine Contract ─────────────────────────────────
NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS=0x... (from Step 1)

# Chain (1 = mainnet, 11155111 = Sepolia)
CHAIN_ID=11155111
```

---

## Step 4 — Set Up Self-hosted Order Executor

The executor is a standalone Node.js process that polls Supabase every 30s and executes orders when conditions are met. It replaces the need for any third-party automation service.

```bash
cd contracts/order-engine/executor

# Install dependencies
npm install

# Create config from example
cp .env.executor.example .env.executor

# Edit .env.executor with your values:
# - RPC_URL: Your RPC endpoint (Alchemy/Infura recommended)
# - EXECUTOR_PRIVATE_KEY: Wallet that pays gas (use deployer for testnet)
# - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY: Server-side Supabase keys
# - ORDER_EXECUTOR_ADDRESS: Contract address from Step 1

# Start the executor
npm start
```

**For production**, use a process manager:
```bash
# Using pm2 (recommended):
npm install -g pm2
pm2 start executor.js --name teraswap-executor
pm2 save
pm2 startup  # Auto-restart on server reboot

# Or using systemd, Docker, Railway, Render, etc.
```

The executor wallet needs ETH for gas. On Sepolia, use the same wallet as the deployer. On mainnet, use a dedicated hot wallet funded with enough ETH for gas.

---

## Step 5 — Verify & Test

### Quick smoke test:

```bash
# Start the app
npm run dev

# Test API routes
curl http://localhost:3000/api/orders?wallet=0x0000000000000000000000000000000000000000
# Should return: {"orders":[]}
```

### End-to-end test:
1. Connect wallet in the UI
2. Go to **Limit Orders** tab
3. Create a limit order (it will EIP-712 sign → Supabase → show in "Active")
4. Check Supabase dashboard: order should appear in `orders` table
5. The executor will pick it up and execute when price condition is met

---

## Architecture Overview

```
User Wallet
    │
    ├─ EIP-712 Sign ──→ Frontend (useOrderEngine hook)
    │                         │
    │                         ├─ POST /api/orders ──→ Supabase (orders table)
    │                         │
    │                         └─ Real-time subscription ──→ Status updates
    │
    └─ approve() ──→ TeraSwapOrderExecutor contract
                          │
                          └─ Self-hosted Executor (every 30s)
                                │
                                ├─ Reads active orders from Supabase
                                ├─ Checks canExecute() on-chain
                                ├─ Fetches swap route from TeraSwap API
                                └─ Sends executeOrder() transaction
```

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Orders not appearing | Missing Supabase env vars | Check `NEXT_PUBLIC_SUPABASE_URL` and anon key |
| "Supabase not configured" on POST | Missing service role key | Set `SUPABASE_SERVICE_ROLE_KEY` (server-side) |
| Orders stuck in "active" | Executor not running | Check executor logs, ensure it's started with `npm start` |
| "Signature mismatch" error | Wrong chain ID or contract address | Verify `CHAIN_ID` and `ORDER_EXECUTOR_ADDRESS` match deployment |
| Real-time updates not working | Replication not enabled | Enable replication for `orders` table in Supabase dashboard |
| Executor "0 ETH" warning | Wallet not funded | Send ETH to the executor wallet address |
| Gas too high | Network congestion | Adjust `MAX_GAS_PRICE_GWEI` in executor.js or wait |
