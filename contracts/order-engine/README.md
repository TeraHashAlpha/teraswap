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
│  Gelato Web3 Function (runs every 30s):                              │
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
| Gelato Function | `gelato/web3Function.ts` | Off-chain monitoring, route building, execution triggering |
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

### 3. Deploy Gelato Web3 Function
```bash
# Install Gelato CLI
npm install -g @gelatonetwork/web3-functions-sdk

# Create secrets file
cat > .env.gelato << EOF
SUPABASE_URL=https://twpcliydcjlwzrpggqdz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<key>
ORDER_EXECUTOR_ADDRESS=<deployed-address>
EOF

# Deploy
npx w3f deploy gelato/web3Function.ts \
  --secrets .env.gelato \
  --chain 1
```

### 4. Connect to TeraSwap Frontend
- Copy `api/orders.ts` to `src/app/api/orders/route.ts`
- Add order creation UI to SwapBox
- Add orders list/management page

## Fee Structure

- **0.1% (10 bps)** on each executed order (same as regular swaps)
- Fee collected in input token before swap execution
- Gelato execution fees paid from prepaid Gelato balance (ETH)

## Roadmap

### Phase 1: Gelato (Current)
- ✅ TeraSwapOrderExecutor.sol — smart contract
- ✅ Gelato Web3 Function — off-chain monitoring
- ✅ Supabase orders table — order storage
- ✅ API routes — order management
- ⬜ Audit smart contract
- ⬜ Deploy to testnet → mainnet
- ⬜ Frontend integration (order creation UI)
- ⬜ Deploy Gelato function

### Phase 2: Custom Keeper Network (Future)
- Replace Gelato with TeraSwap's own keeper network
- Run dedicated nodes monitoring orders
- Lower latency (sub-10s execution)
- No Gelato fees — only gas costs
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
5. **Gelato Trust**: Gelato is the executor — they can't steal funds (contract verifies everything on-chain) but could grief by not executing
6. **User Cancellation**: Users can always cancel orders or revoke token approvals
