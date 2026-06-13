# TeraSwap Order Engine

> Conditional swap execution — Limit Orders, Stop-Loss, and DCA — without keeping the browser open.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER FLOW                                     │
│                                                                      │
│  1. User creates order in UI (limit/SL/DCA)                         │
│  2. User signs EIP-712 intent via wallet (gasless)                   │
│  3. Order + signature stored in Supabase                             │
│  4. User can close browser — done!                                   │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                      EXECUTION FLOW                                  │
│                                                                      │
│  Self-hosted executor (executor/executor.js, every 30s):             │
│    → Fetches active orders from Supabase                             │
│    → Checks conditions via OrderExecutor.canExecute()                │
│    → When conditions met: builds swap route + executes               │
│    → OrderExecutor verifies signature + price on-chain               │
│    → Swap executed, tokens sent to user                              │
│    → Order status updated in Supabase                                │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                      SECURITY                                        │
│                                                                      │
│  • User approves OrderExecutor contract (not routers)                │
│  • EIP-712 signature verified on-chain                               │
│  • Chainlink price oracles for condition verification                │
│  • Whitelisted routers only (admin-managed)                          │
│  • Nonce tracking prevents replay attacks                            │
│  • Users can cancel anytime (on-chain or via API)                    │
│  • minAmountOut enforced on-chain (slippage protection)              │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

| Component | File | Description |
|-----------|------|-------------|
| Smart Contract | `TeraSwapOrderExecutor.sol` | On-chain execution, signature verification, price checks |
| Self-hosted Executor | `executor/executor.js` | Off-chain order polling, on-chain condition checks, route building, `executeOrder()` submission |
| DB Schema | `schema.sql` | Supabase orders table with indexes |
| API Routes | `api/orders.ts` | CRUD operations for orders (draft) |

## Order Types

### Limit Order
- **Condition**: Execute when token price reaches target
- **Example**: "Buy ETH when price drops to $3,000"
- **Price Feed**: Chainlink ETH/USD oracle
- **Execution**: Once

### Stop-Loss
- **Condition**: Execute when token price drops below threshold
- **Example**: "Sell ETH if price drops below $2,800"
- **Price Feed**: Chainlink ETH/USD oracle
- **Execution**: Once

### DCA (Dollar-Cost Average)
- **Condition**: Execute at regular intervals regardless of price
- **Example**: "Buy $100 of ETH every day for 30 days"
- **Price Feed**: None (time-based only)
- **Execution**: Multiple (dcaTotal times, every dcaInterval seconds)

## Deployment Steps

### 1. Deploy Smart Contract
```bash
# Compile
forge build

# Deploy to mainnet (update constructor args)
forge create TeraSwapOrderExecutor \
  --rpc-url $RPC_URL \
  --private-key $DEPLOYER_KEY \
  --constructor-args $FEE_RECIPIENT $ADMIN_ADDRESS

# Whitelist routers
cast send $EXECUTOR "setRouter(address,bool)" $UNISWAP_ROUTER true
cast send $EXECUTOR "setRouter(address,bool)" $ONEINCH_ROUTER true
# ... add all DEX routers
```

### 2. Run Supabase Schema
```sql
-- Run schema.sql in Supabase SQL Editor
```

### 3. Run the self-hosted executor
The executor (`executor/executor.js`) is a standalone Node.js keeper: it polls Supabase for active
orders, checks each one's conditions on-chain via `canExecute()`, builds the swap route, and submits
`executeOrder()` transactions directly. The **executor wallet pays gas**, so keep it funded.

```bash
cd executor

# Required environment (server-side only — never expose the signer):
#   RPC_URL                     — chain RPC endpoint
#   EXECUTOR_PRIVATE_KEY        — executor wallet key (pays gas)
#                                 (or KMS_KEY_ID / VAULT_ADDR for a managed signer)
#   SUPABASE_URL                — Supabase project URL
#   SUPABASE_SERVICE_ROLE_KEY   — Supabase service-role key
#   ORDER_EXECUTOR_ADDRESS      — deployed OrderExecutor address
#   CHAIN_ID                    — target chain id (defaults to mainnet)
# Optional: FLASHBOTS_RPC_URL (MEV-protected submission), gas-tier overrides.

# Start it (typically under a process manager / systemd / container):
node executor.js
```

### 4. Connect to TeraSwap Frontend
- Copy `api/orders.ts` to `src/app/api/orders/route.ts`
- Add order creation UI to SwapBox
- Add orders list/management page

## Fee Structure

- **0.1% (10 bps)** on each executed order (same as regular swaps)
- Fee collected in input token before swap execution
- Gas is paid directly by the executor wallet (must be funded with ETH) — no third-party keeper fees

## Roadmap

### Phase 1: Self-hosted executor (Current)
- ✅ TeraSwapOrderExecutor.sol — smart contract (deployed on Ethereum mainnet)
- ✅ Self-hosted executor (`executor/executor.js`) — off-chain keeper that replaced the deprecated Gelato Web3 Function (March 2026)
- ✅ Supabase orders table — order storage
- ✅ API routes — order management
- ✅ Frontend order creation + management UI
- ⬜ Base OrderExecutor deployment (byte-identical redeploy — see `docs/Runbooks/BASE-ORDEREXECUTOR-DEPLOY.md`)

### Phase 2: Keeper Network (Future)
- Run dedicated, redundant keeper nodes monitoring orders
- Lower latency (sub-10s execution)
- MEV-protected execution via Flashbots
- Multi-chain support (Arbitrum, Base, Polygon)

### Phase 3: Advanced Order Types
- Trailing stop-loss
- TWAP (Time-Weighted Average Price)
- Range orders (buy between $X and $Y)
- Conditional chains (if order A fills, create order B)
- Cross-chain orders

## Security Considerations

1. **Audit Required**: The OrderExecutor contract MUST be audited before mainnet deployment
2. **Router Whitelist**: Only admin can add/remove routers — prevents routing to malicious contracts
3. **Signature Replay**: Nonce tracking prevents the same signature from being used twice
4. **Price Manipulation**: Chainlink oracles are resistant to flash loan attacks
5. **Executor Trust**: The self-hosted executor wallet triggers execution — it cannot steal funds (the contract verifies the EIP-712 signature, Chainlink price condition, router whitelist, nonce, and `minAmountOut` on-chain) but could grief by not executing. TeraSwap runs the executor itself, so there is no third-party keeper dependency.
6. **User Cancellation**: Users can always cancel orders or revoke token approvals
