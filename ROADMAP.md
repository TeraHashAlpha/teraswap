# TeraSwap — Roadmap

## Completed

- **Meta-aggregation engine** — 11 liquidity sources shipped (1inch, 0x, Velora, Odos, KyberSwap, CoW Protocol, OpenOcean, Uniswap V3, SushiSwap, Balancer V2, Curve Finance); **10 active today** — Odos permanently disabled 2026-07-30 (vendor shutdown)
- **MEV protection** — CoW Protocol batch auctions + Chainlink price validation
- **Gasless approvals** — Permit2 / EIP-2612 off-chain signing
- **FeeCollector contract** — 0.1% protocol fee with on-chain routing
- **Swap reliability fix** — Fallback receipt polling, increased gas buffers, pending tx Etherscan link
- **Supabase analytics** — Swap history tracking, quote analytics, aggregator win-rates
- **Analytics dashboard** — Volume trends, popular pairs, protocol performance
- **Swap history** — Per-wallet swap records via Supabase with wei-to-human conversion
- **Active approvals manager** — View and revoke token allowances
- **Split routing execution** — Multi-leg split swap across DEXes for large trades (analysis + visualization + execution)
- **Smart contract audit skill** — 4-phase MAP→HUNT→ATTACK→REPORT methodology with 40+ vulnerability patterns
- **Landing page & Coming Soon UI** — Feature cards updated, DCA/Limit/SL·TP tabs with "Soon" badges
- **Order Engine Phase 1 — complete** — Hardened contract v2, self-hosted executor (replaced Gelato), Supabase backend, API routes, frontend SDK, 22/22 tests passing, full security audit (0 Critical, 0 High)
- **Sepolia deployment** — Contract `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`, Supabase tables live, self-hosted executor running

---

## Phase 1 — Autonomous Order Engine ✅

Fully autonomous on-chain order execution — no browser required.
TeraSwapOrderExecutor v2 deployed with all audit findings resolved.

### 1.1 Smart Contract Hardening ✅
- [x] Fix H-01: Include `router` address in EIP-712 signed order data
- [x] Fix H-02: Add ETH output handling (wrap to WETH via `call{value}`)
- [x] Fix H-03: Add on-chain cancellation mapping (`cancelledOrders` + `invalidateNonces`)
- [x] Fix H-04: MEV-resistant execution (Flashbots Protect relay in Gelato function)
- [x] Add M-01: Pre-execution balance check (`canExecute` view function)
- [x] Add M-02: Timelock for admin functions (48h `TimelockController` for router whitelist)
- [x] Add L-03: Minimum output amount per order (`minAmountOut` field)
- [x] Comprehensive unit + integration tests — 22/22 passing (Hardhat + custom runner)
- [x] Full audit using `sc-audit` skill — 0 Critical, 0 High, 3 Medium (all fixed)

### 1.2 Autonomous Executor ✅
- [x] Implement `fetchSwapRoute()` — calls TeraSwap aggregation API
- [x] Fix M-03: Atomic check-and-execute (nonce invalidation prevents race conditions)
- [x] Fix L-04: Batch multiple order executions per cycle
- [x] Order prioritization (oldest first, then by gas efficiency)
- [x] Self-hosted executor (`contracts/order-engine/executor/`) — replaces Gelato Web3 Functions (deprecated March 2026)
- [x] Gas price safety cap (MAX_GAS_PRICE_GWEI = 100)
- [x] Stale lock recovery (60s timeout on "executing" status)
- [x] DCA execution tracking with Supabase `order_executions` table

### 1.3 Backend / Supabase ✅
- [x] Fix L-05: RLS policies (user can only read/cancel own orders)
- [x] Fix L-06: Wallet address validation (checksum + format)
- [x] Fix M-05: Signature verification on order creation (API-side EIP-712 recovery)
- [x] Rate limiting on order creation endpoint
- [x] Real-time order status via Supabase `postgres_changes` subscriptions

### 1.4 Frontend Integration ✅
- [x] Remove "Coming Soon" notices from DCA / Limit / SL·TP tabs
- [x] Order Engine SDK (`src/lib/order-engine/`) — ABI, types, config, Supabase client
- [x] `useOrderEngine` hook — EIP-712 signing, Supabase CRUD, real-time polling
- [x] Connect panels to autonomous order engine
- [x] Real-time order status via Supabase subscriptions
- [ ] Order management UI polish (view active orders, cancel, edit) — _Phase 1.5_
- [ ] Execution history per order (fills, partial fills) — _Phase 1.5_

---

## Phase 2 — Multi-Chain Expansion

- [x] ~~**Base support**~~ — ✅ **LIVE & fully hardened** (2026-06-02). Chain-aware adapters
  (Sprints 43–45 + 9C), per-chain Uniswap V3 registry, FeeCollector + routers whitelisted on Base,
  gas/fee in ETH+USD, Base/mainnet UI parity (9E). **11 sources incl. Bebop** (ADR-010, 9D; was 12 — Odos permanently disabled 2026-07-30, vendor shutdown).
  **Safety/oracle gates chain-aware** (9G: Chainlink + L2 sequencer, DefiLlama >$10k guard,
  post-execution validator, server-side activation gate — all per-chain; rule #9 satisfied on Base).
  **Source-execution fixed** (9H: Velora/Augustus V6.2 Curve selectors, Bebop fail-soft).
  Verified in prod: Velora + Kyber execute, multi-source Compare + USD, mainnet byte-identical.
- [ ] Arbitrum support (adapt FeeCollector + aggregation APIs) — next chain
- [ ] Polygon support
- [ ] Chain-aware routing (bridge + swap in one flow)
- [ ] Cross-chain order execution

_Base arc references: ADR-009 (multi-chain), ADR-010 (Bebop), Sprints 43–45 + 9C/9D/9E/9F/9G/9H,
full-codebase audit `Audits/FULL-AUDIT-2026-06-02.md` (0C/0H), INC-2026-05-31-001 (502 → resolved).
Follow-ups (non-blocking): Bebop API key (Prod+Preview), Supabase key in Preview scope, Alchemy key
allowlist, Basescan contract verification, 9G-L-01 (Balancer BatchRelayer target per chain)._

---

## Phase 3 — Advanced Trading Features

- [x] ~~Split routing optimization~~ _(Completed — multi-leg execution in useSplitSwap.ts)_
- [ ] TWAP orders (time-weighted average price execution) — requires Order Engine (Phase 1)
- [ ] Trailing stop loss — requires Order Engine (Phase 1)
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

_Phase 1 Order Engine deliverables: `contracts/order-engine/` (contract v2 + self-hosted executor + Supabase schema + API routes + test suite + audit report), `src/lib/order-engine/` (frontend SDK), `src/hooks/useOrderEngine.ts` (React hook)._
