# TeraSwap — Roadmap

## Completed

- **Meta-aggregation engine** — 11 liquidity sources (1inch, 0x, Velora, Odos, KyberSwap, CoW Protocol, OpenOcean, Uniswap V3, SushiSwap, Balancer V2, Curve Finance)
- **MEV protection** — CoW Protocol batch auctions + Chainlink price validation
- **Gasless approvals** — Permit2 / EIP-2612 off-chain signing
- **FeeCollector contract** — 0.1% protocol fee with on-chain routing
- **Swap reliability fix** — Fallback receipt polling, increased gas buffers, pending tx Etherscan link
- **Supabase analytics** — Swap history tracking, quote analytics, aggregator win-rates
- **Analytics dashboard** — Volume trends, popular pairs, protocol performance
- **Wallet history** — Full on-chain tx history per wallet
- **Active approvals manager** — View and revoke token allowances

---

## Phase 1 — Autonomous Order Engine _(In Progress)_

Replace browser-dependent execution with fully autonomous on-chain orders.

### 1.1 Smart Contract Hardening
- [ ] Fix H-01: Include `router` address in EIP-712 signed order data (prevents executor from choosing arbitrary router)
- [ ] Fix H-02: Add ETH output handling (wrap to WETH or use `call{value}`)
- [ ] Fix H-03: Add on-chain cancellation mapping (prevent cancelled orders from being executed)
- [ ] Fix H-04: Implement MEV-resistant execution (Flashbots Protect / private mempool relay)
- [ ] Add M-01: Pre-execution balance check
- [ ] Add M-02: Timelock for admin functions (router whitelist changes)
- [ ] Add L-03: Minimum output amount per order (user-configurable slippage)
- [ ] Comprehensive unit + integration tests (Foundry)

### 1.2 Gelato Web3 Function
- [ ] Implement `fetchSwapRoute()` — call TeraSwap aggregation API from Gelato function
- [ ] Fix M-03: Atomic check-and-execute (race condition prevention)
- [ ] Fix M-04: Scope Gelato API key to read-only where possible
- [ ] Fix L-04: Batch multiple order executions per cycle
- [ ] Add order prioritization (oldest first, then by gas efficiency)

### 1.3 Backend / Supabase
- [ ] Fix L-05: Add proper RLS policies (user can only read/cancel own orders)
- [ ] Fix L-06: Add wallet address validation (checksum + format)
- [ ] Fix M-05: Add signature verification on order creation (API side)
- [ ] Add rate limiting on order creation endpoint
- [ ] Add order status webhooks / real-time subscriptions

### 1.4 Frontend Integration
- [ ] Remove "Coming Soon" notices from DCA / Limit / SL·TP tabs
- [ ] Connect panels to the new autonomous order engine
- [ ] Add order management UI (view active orders, cancel, edit)
- [ ] Add execution history per order (fills, partial fills)
- [ ] Real-time order status via Supabase subscriptions

---

## Phase 2 — Multi-Chain Expansion

- [ ] Arbitrum support (adapt FeeCollector + aggregation APIs)
- [ ] Base support
- [ ] Polygon support
- [ ] Chain-aware routing (bridge + swap in one flow)
- [ ] Cross-chain order execution

---

## Phase 3 — Advanced Trading Features

- [ ] Split routing optimization (auto-split large trades across DEXes)
- [ ] TWAP orders (time-weighted average price execution)
- [ ] Trailing stop loss
- [ ] Portfolio rebalancing
- [ ] Price alerts (email / push notifications)

---

## Phase 4 — Protocol & Community

- [ ] Governance token design
- [ ] Fee-sharing mechanism
- [ ] Referral program
- [ ] Public API for third-party integrations
- [ ] Mobile-responsive PWA optimization

---

_Branch `order-engine-backup` contains the initial Order Engine implementation (contract + Gelato + schema + API) ready for Phase 1 hardening._
