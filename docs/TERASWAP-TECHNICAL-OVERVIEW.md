# TeraSwap — Technical Architecture & Security Overview

**Version:** 2026-04-17 | **Network:** Ethereum Mainnet | **Status:** Pre-launch (all audit findings closed)

---

## 1. What is TeraSwap

TeraSwap is an Ethereum DEX **meta-aggregator** — it queries 10 independent liquidity sources simultaneously (11 incl. Bebop), selects the best execution path, and routes the swap through a fee-collecting proxy contract. It also supports autonomous order execution (Limit, Stop-Loss, DCA) via EIP-712 signed orders and an off-chain keeper network.

**Deployed contracts:**
- `TeraSwapFeeCollector` (V2, current — adds `minimumOutput` revert per H-04) — `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`
- `TeraSwapFeeCollector` (V1, frozen — kept for analytics continuity, no new swaps route here) — `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD`
- `TeraSwapOrderExecutor` — `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`
- Fee Recipient — `0x107F6eB7C3866c9cEf5860952066e185e9383ABA`

**Stack:** Next.js (Vercel serverless) · Solidity 0.8.28 · Vercel KV (Upstash Redis) · Supabase · Cloudflare Workers · Capacitor (mobile)

---

## 2. Liquidity Sources (10 Adapters)

Each source implements a unified `DEXAdapter` interface (`fetchQuote()` + `fetchSwapData()`), wrapped with per-source circuit breakers.

> **Odos** ceased all operations 2026-07-30 (vendor shutdown) and is permanently
> disabled via `DISABLED_SOURCES.odos` — no longer in the active table below.
> The adapter file and its on-chain router whitelist entries are kept (never
> deleted) but dormant: the API layer never quotes it, so no order can route
> there.

| # | Source | Type | Protocol |
|---|--------|------|----------|
| 1 | **1inch** | Meta-aggregator | Pathfinder routing |
| 2 | **0x** | RFQ + AMM | Professional market makers |
| 3 | **Velora** | Order-flow auction | MEV-protected execution |
| 4 | **KyberSwap** | Concentrated liquidity aggregator | Elastic pools |
| 5 | **CoW Protocol** | Intent-based (EIP-712) | Batch auction with surplus capture |
| 6 | **Uniswap V3** | Direct pool | Fee-tier auto-detection |
| 7 | **OpenOcean** | Cross-chain aggregator | Multi-DEX routing |
| 8 | **SushiSwap** | AMM | Trident pools |
| 9 | **Balancer** | Weighted pools | Vault-based liquidity |
| 10 | **Curve** | StableSwap | Optimized for pegged assets |

---

## 3. Swap Execution Flow

### 3.1 Standard Swap (Aggregator Sources)

```
User selects tokens + amount
        │
        ▼
┌─────────────────────────────┐
│  PHASE 1 — Quote Discovery  │
│  /api/swap → 11 adapters    │
│  parallel fetchQuote()      │
│  → NormalizedQuote[]        │
│  → best quote selected      │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  PHASE 2 — Security Gates   │
│                             │
│  ① Router address validation│
│  ② Calldata length sanity   │
│     (10 chars min, 100KB max│
│  ③ Selector allowlist check │
│     (19 validated selectors)│
│  ④ Recipient extraction +   │
│     mismatch detection      │
│  ⑤ Fee integrity validation │
│     (output vs quote check) │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  PHASE 3 — Simulation       │
│  eth_call (no state change) │
│  → catches: insufficient    │
│    funds, STF, reverts      │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  PHASE 4 — Transaction      │
│  Preview (Clear Signing)    │
│                             │
│  Decoded calldata display:  │
│  • Source DEX + function    │
│  • Token in/out + amounts   │
│  • Recipient ("Your wallet")│
│  • Min output + deadline    │
│  • Validation status badge  │
│  • Collapsible raw calldata │
│                             │
│  User: [Confirm] or [Cancel]│
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  PHASE 5 — On-Chain         │
│                             │
│  FeeCollector route:        │
│  User → FeeCollector        │
│    → deduct 0.1% (10 BPS)  │
│    → forward net to Router  │
│    → Router executes swap   │
│    → output tokens to User  │
│    → refund leftover ETH    │
│                             │
│  Receipt polling: 2s wagmi  │
│  + 3s manual fallback (8s) │
│  Hard timeout: 120s         │
└─────────────────────────────┘
```

### 3.2 CoW Protocol Flow (Intent-Based)

```
User selects CoW source
        │
        ▼
  Balance + Allowance pre-flight
  (balanceOf + allowance to GPv2VaultRelayer)
        │
        ▼
  EIP-712 order signing
  Domain: "Gnosis Protocol v2" @ COW_SETTLEMENT
  (No preview modal — EIP-712 wallet dialog is already structured)
        │
        ▼
  Order submitted to CoW orderbook
        │
        ▼
  Polling: 120s timeout, 2s interval
  States: cow_signing → cow_pending → success/error
```

### 3.3 Autonomous Order Execution (Limit / Stop-Loss / DCA)

```
User signs EIP-712 order (off-chain)
        │
        ▼
  Stored in Supabase (signature + order hash + nonce)
        │
        ▼
  Keeper checks every 30s:
    canExecuteOrder(order)?
    ├─ Price condition met? (Chainlink oracle, 5min staleness max)
    ├─ Not expired?
    ├─ Not cancelled?
    ├─ Nonce valid?
    └─ DCA interval elapsed? (if DCA)
        │
        ▼
  executeOrder(order, signature, routerData)
    ├─ Verify ECDSA signature → signer == order.owner
    ├─ Verify routerDataHash == keccak256(routerData) [non-DCA]
    ├─ Verify router whitelisted
    ├─ Verify nonce not invalidated
    ├─ Pre-exec balanceOf + allowance check
    ├─ Deduct 0.1% fee
    ├─ safeTransferFrom(owner → contract)
    ├─ Approve router → execute swap via call()
    ├─ Verify output balance delta
    └─ Deliver tokens to owner (ERC-20 or unwrap WETH→ETH)
```

**DCA specifics:**
- Cumulative execution model prevents dust accumulation
- Per-execution: `amountIn / dcaTotal` with remainder on last execution
- `routerDataHash` allows `bytes32(0)` for DCA (calldata varies per execution)

---

## 4. Fee Model

```
Fee = 0.1% (10 BPS) on input amount

User sends 100 USDC
  → Fee: 0.1 USDC → feeRecipient
  → Net: 99.9 USDC → DEX router
  → Output: ~99.85 ETH (after DEX fees + slippage)
```

- **FeeCollector** handles ETH and ERC-20 paths separately
- Fee deducted BEFORE routing (ensures DEX receives exact net amount)
- Fee integrity validated client-side: if output is unexpectedly high, fee may have been bypassed → swap blocked

---

## 5. Security Architecture (17 Layers)

### Layer 1 — Smart Contract Security

| Control | Implementation | Audit Finding |
|---------|---------------|---------------|
| **Reentrancy guard** | OpenZeppelin `nonReentrant` on all state-changing functions | SC-H-03 ✅ |
| **Router whitelist** | `whitelistedRouters[address]` — only approved DEX contracts | — |
| **Executor whitelist** | `whitelistedExecutors[msg.sender]` — only approved keepers | SC-H-01 ✅ |
| **48h timelock** | All admin operations (setExecutor, router changes, sweep) require propose → 48h wait → execute. 7-day grace for admin transfer. Cancel available. | SC-H-01 ✅ |
| **Calldata commitment** | `routerDataHash == keccak256(routerData)` — user commits to exact swap calldata in EIP-712 signature. Prevents executor substituting routing. | SC-C-01 ✅ |
| **ETH receive guard** | `receive()` only accepts ETH during active swap execution (`_inSwap` / `_inExecution` flag). Prevents accidental ETH deposits. | SC-H-02 ✅ |
| **Oracle staleness** | Chainlink price feed: 5-minute max staleness (hardened from 1h). Reverts on stale data. | SC-H-03 ✅ |
| **Minimum order size** | 10,000 wei minimum — prevents zero-fee attacks | SC-M-01 ✅ |
| **Emergency pause** | `paused` flag halts all swap execution. Separate from monitoring kill-switch. | — |

### Layer 2 — Calldata Validation (Fail-Closed)

19 validated swap selectors across 6 classification groups:

| Group | Strategy | Selectors | Sources |
|-------|----------|-----------|---------|
| A | `msg.sender` implicit | 4 | 1inch (uniswapV3Swap, unoswap), 0x (sellToUniswap, transformERC20) |
| B | Recipient extracted from calldata | 3 | Uniswap V3 (exactInputSingle, exactInput), 1inch (unoswapTo) |
| C | Multicall recursive validation | 2 | Uniswap V3 (multicall variants) |
| D | V2-style with deadline | 2 | Legacy swapExactTokensForTokens variants |
| E | 0x protocol-specific | 3 | 0x (fillOtcOrder, multiplexBatchSellTokenForToken, etc.) |
| F | Trusted router (design-verified) | 5 | Odos, KyberSwap, ParaSwap (3 selectors) |

**Any selector NOT in the allowlist → `valid: false` → swap blocked.** Unknown selectors are logged via `console.warn` for future analysis.

### Layer 3 — Pre-Swap Simulation

Every swap is simulated via `eth_call` before execution. Catches:
- Insufficient balance/allowance
- Transfer failures (STF)
- Slippage mismatches
- Contract reverts

Simulation failures are logged but do NOT block execution (advisory). The on-chain contract provides the hard revert.

### Layer 4 — Transaction Preview (Clear Signing)

Before wallet signature, users see a decoded transaction preview:
- Source DEX name + function name
- Token in/out with amounts
- Recipient address with badge: "Your wallet" / "Router (implicit)"
- Minimum output amount (slippage protection)
- Deadline (relative time)
- Validation status
- Collapsible raw calldata for advanced users

CoW Protocol skips this (EIP-712 wallet dialog is already structured).

### Layer 5 — Post-Execution Balance Validation (P45)

**Inspired by:** Rhea Finance exploit (April 2026, $7.6M) — pre-trade validation without post-trade enforcement.

After each swap execution, an advisory validator compares actual output against expected minimum:

| Severity | Condition | Action |
|----------|-----------|--------|
| `ok` | actual ≥ expected | Log only |
| `warning` | actual 0-2% below expected | Telegram INFO alert |
| `critical` | actual >2% below expected | **P0 alert** (all channels) + **auto-disable source** |
| `unknown` | RPC failure | Log, no action |

**Extraction method:** Primary — parse ERC-20 `Transfer` events from TX receipt. Fallback — `balanceOf` delta if no Transfer logs.

**Non-blocking:** Validation is advisory. The executor is never blocked. The validator is the last line of defense, not a gate.

### Layer 6 — Source Health Monitoring (60s cadence)

**Tick architecture** (Cloudflare Worker → Vercel serverless):

```
Every 60 seconds:
  ① Acquire distributed lock (KV SET NX, 55s TTL)
  ② Cold-start detection (gap >5min → skip latency recording)
  ③ Health check all 10 active source endpoints (parallel; odos permanently disabled)
  ④ Feed results into per-source state machine
  ⑤ Process state transitions (active ↔ degraded ↔ disabled)
  ⑥ Auto-recovery for non-P0 disabled sources
  ⑦ Quorum cross-check (every 5th tick)
  ⑧ Circuit breaker evaluation
  ⑨ On-chain event scan (every 5th tick)
  ⑩ Emit transition alerts
  ⑪ Write heartbeat to KV (dead-man's switch)
```

### Layer 7 — Source State Machine

```
       3 failures         2 more failures
active ────────► degraded ────────────► disabled
  ▲                                       │
  │          3 successes (non-P0)         │
  └───────────────────────────────────────┘
  
  P0 disabled → NO auto-recovery (manual only)
```

Per-source configurable thresholds (`data/source-thresholds.json`):
- `failuresToDegraded`: 3 (default), 2 (teraswap-self, cowswap)
- `failuresToDisabled`: 5 (default), 3 (teraswap-self, cowswap), 7 (1inch, 0x)
- `p95LatencyThresholdMs`: 5000ms (default), 3000ms (teraswap-self)
- `quorumMaxDeviationPercent`: 5% (default), 8% (cowswap — batch auction mechanics)

### Layer 8 — Quorum Cross-Check (H5)

Every 5 minutes, queries reference pairs (WETH→USDC, WETH→USDT) across all active sources. Applies IQR outlier pre-filter, then checks deviation from median:

| Classification | Condition | Action |
|---------------|-----------|--------|
| `warning` | 1 pair deviates >threshold | Log, no action |
| `flagged` | 2/2 pairs deviate | Disable source + alert |
| `correlated` | ≥3 sources flagged simultaneously | **Force-disable ALL flagged** (P0) |

Minimum 5 active sources required for quorum validity.

### Layer 9 — Circuit Breaker (P46)

Detects systemic events (coordinated attacks, provider outages):

| Trigger | Condition | Action |
|---------|-----------|--------|
| **Majority** | ≥6 of 10 sources disabled | P0 systemic alert (all channels) |
| **Rapid cascade** | ≥4 sources disabled within 10 minutes | P0 systemic alert (all channels) |

15-minute cooldown prevents alert storms during prolonged outages. Alert-only — no automatic routing pause (deliberate design: avoid self-inflicted DoS).

### Layer 10 — On-Chain Event Monitoring (P47)

Scans `FeeCollector` and `OrderExecutor` contract events via `eth_getLogs` every 5 minutes:

| Severity | Events |
|----------|--------|
| **INFO** | OrderExecuted, OrderCancelled, NoncesInvalidated, SwapWithFee (small) |
| **WARNING** | SweepQueued, Bootstrap, OracleConfigured, ExecutorChangeCancelled, SwapWithFee (≥1 ETH auto-elevated) |
| **CRITICAL** | AdminTransferred, ExecutorChangeProposed, ExecutorChangeExecuted, ExecutorWhitelisted, RouterWhitelisted, TimelockQueued, TimelockExecuted, Paused, Unpaused, OwnershipTransferred |

Critical events → P0 full fan-out (Telegram + Email + Discord). Block range capped at 1000 per scan.

### Layer 11 — TLS/DNS Baseline Monitoring (H2)

Every tick captures live TLS certificate fingerprints and DNS records for all monitored endpoints. Any change triggers:
- **TLS fingerprint change** → P0 disable (possible MITM/certificate hijack)
- **DNS record change** → P0 disable (possible DNS hijack, per CoW Swap incident)

### Layer 12 — Kill Switch

`POST /api/admin/kill-switch` — instant source disable with:
- Constant-time Bearer auth (SHA-256 + timingSafeEqual)
- Rate limiting: 10 requests/minute per IP
- KV audit trail (sourceId, reason, previousState, timestamp)
- No re-activation endpoint (friction by design)

### Layer 13 — Operator Commands (Telegram Bot)

| Command | Access | Function |
|---------|--------|----------|
| `/status` | All | Source states table |
| `/quorum` | All | Latest cross-check results |
| `/heartbeat` | All | Monitoring loop health |
| `/disable <id>` | Admin | Force-disable (auto-recovery possible) |
| `/lock <id> <reason>` | Admin | P0 permanent disable (no auto-recovery) |
| `/activate <id> confirm` | Admin | Re-enable disabled source |
| `/grace <ISO8601>` | Admin | Set maintenance window |

Inline buttons on alerts: `Activate` · `Keep disabled` · `Escalate` (rate-limited: 1 per source per 5min) · `Acknowledge`

### Layer 14 — Alert System

**Three channels:** Telegram (LIVE) · Email/Resend (configured, not active) · Discord webhook (configured, not active)

**Deduplication:** Counter-based, 3 alerts per 15-minute window per source. P0 alerts use 5-minute dedup. Oscillation warning on 3rd alert.

**Grace period:** During maintenance windows, alerts emit with `[GRACE]` tag to Telegram only (no buttons, don't consume dedup slot). P0 bypasses grace.

### Layer 15 — Authentication

All authenticated endpoints use a shared `verifyBearerToken()` utility:
```
SHA-256(provided_token) timingSafeEqual SHA-256(expected_secret)
```
SHA-256 pre-hash eliminates length leak. Returns 503 if secret not configured (fail-closed), 401 if invalid.

### Layer 16 — Infrastructure Hardening

| Control | Implementation |
|---------|---------------|
| **Security headers** | CSP, HSTS (preload), Permissions-Policy, COOP, CORP, X-Frame-Options DENY — applied at both Next.js and Vercel edge (defense-in-depth) |
| **CI/CD** | GitHub Actions: 6 parallel jobs, Node 22, all Actions pinned to SHA (not tag), Foundry for Solidity |
| **Dependencies** | Dependabot + `npm audit --audit-level=high` gate in CI + lockfile-lint |
| **RPC proxy** | `/api/rpc` whitelists specific methods, hides user IP from upstream providers, rate-limited per IP |
| **KV namespacing** | All keys under `teraswap:` prefix with appropriate TTLs |
| **Distributed lock** | Monitor tick uses KV SET NX (55s TTL) to prevent concurrent execution |
| **Cold-start handling** | Vercel Hobby cold starts detected via >5min gap — latency measurements discarded, availability still recorded |

### Layer 17 — Forensic Tooling

- **Executor compromise runbook** (`docs/Runbooks/executor-compromise.md`): Decision tree with time targets (<5min kill-switch, 5-30min assessment, 30min-2h containment), copy-paste command templates, quarterly drill schedule with 4 rotating scenarios.
- **TxAnalyzer skill** (`skills/tx-analyzer/`): On-demand forensic analysis — decodes TX receipt, maps fund flows, flags anomalies (flash loans, reentrancy, unexpected recipients). Includes ABIs for both TeraSwap contracts + common DeFi protocols (ERC20, UniV2/V3, Permit2, Aave, Balancer, Curve, CoW).

---

## 6. P0 Classification System

Seven reasons that block auto-recovery and trigger immediate full fan-out:

| P0 Reason | Trigger |
|-----------|---------|
| `kill-switch-triggered` | Manual operator kill switch |
| `tls-fingerprint-change` | TLS certificate changed (possible MITM) |
| `dns-record-change` | DNS records changed (possible hijack) |
| `kv-store-failure` | State persistence layer unreachable |
| `quorum-correlated-anomaly` | ≥3 sources with correlated price deviation |
| `operator-lock` | Telegram `/lock` command (permanent disable) |
| `circuit-breaker-tripped` | ≥6 sources disabled OR ≥4 in 10min cascade |

---

## 7. Audit History

| Audit | Scope | Findings | Status |
|-------|-------|----------|--------|
| Sprint 4 audit | Smart contracts + API | Multiple rounds | APPROVED WITH WARNINGS |
| Sprint 5A-5C audit | Monitoring stack + Telegram bot | Incremental | APPROVED |
| **Comprehensive post-5C** | Full codebase (25 areas, 6 phases) | **2C · 7H · 6M · 5L = 20 findings** | **ALL 20 CLOSED** |
| Sprint 6A | Smart contract blockers | 4/4 closed | APPROVED (0 warnings) |
| Sprint 6B | API auth + monitoring hardening | 6/6 closed | APPROVED (0 warnings) |
| Sprint 6C | Medium priority fixes | 4/4 closed | APPROVED (0 warnings) |
| Sprint 6D | Headers, dashboard, UX | 4/4 closed | APPROVED (0 warnings) |
| **Sprint 7** | **Forensic & post-execution** | **5 gaps closed, 84 new tests** | **APPROVED (0 warnings)** |

**Cumulative test coverage:** ~323 tests across smart contracts, API routes, monitoring subsystems, state machine, validators, and alert logic.

---

## 8. Runtime Cost

| Component | Provider | Cost |
|-----------|----------|------|
| Hosting | Vercel (Hobby) | $0/mo |
| State persistence | Upstash KV (via Vercel) | $0/mo (free tier) |
| Monitoring scheduler | Cloudflare Worker | $0/mo (free tier) |
| Database | Supabase | $0/mo (free tier) |
| DNS + CDN | Cloudflare | $0/mo |
| CI/CD | GitHub Actions | $0/mo (free tier) |
| **Total** | | **$0/mo** |

---

## 9. Architecture Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │               USER (Browser/Mobile)          │
                    │                                             │
                    │  Quote Discovery → Security Gates →         │
                    │  Simulation → Transaction Preview →         │
                    │  Wallet Signature                           │
                    └──────────────┬──────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────────────┐
                    │         VERCEL (Next.js Serverless)          │
                    │                                             │
                    │  /api/swap ──────── 11 DEX Adapters         │
                    │  /api/orders ────── Supabase (storage)      │
                    │  /api/rpc ──────── Ethereum RPC Proxy       │
                    │  /api/monitor/* ── Health + Validation      │
                    │  /api/admin/* ──── Kill Switch              │
                    │  /api/telegram/* ─ Bot Webhook              │
                    │  /status ──────── Public Dashboard          │
                    └──────────────┬──────────────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────────┐
          │                        │                            │
          ▼                        ▼                            ▼
┌──────────────────┐  ┌──────────────────────┐  ┌────────────────────┐
│  ETHEREUM MAINNET │  │   UPSTASH KV (Redis)  │  │   CLOUDFLARE       │
│                  │  │                      │  │                    │
│  FeeCollector    │  │  Source states        │  │  Worker cron (60s) │
│  OrderExecutor   │  │  Alert dedup          │  │  DNS + CDN         │
│  11 DEX Routers  │  │  Tick lock            │  │  TLS termination   │
│  Chainlink Oracle│  │  Execution audit      │  │  Security headers  │
│                  │  │  Circuit breaker      │  │                    │
└──────────────────┘  └──────────────────────┘  └────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────────┐
│                    MONITORING STACK (per tick)                    │
│                                                                  │
│  H1: Health checks (10 sources, parallel)                        │
│  H2: TLS fingerprint + DNS record validation                    │
│  H5: Quorum cross-check (every 5th tick, IQR + median)          │
│  P45: Post-execution balance validation                          │
│  P46: Circuit breaker (majority + cascade detection)             │
│  P47: On-chain event monitor (eth_getLogs, admin ops = critical) │
│  H6: Telegram bot (alerts + operator commands)                   │
│                                                                  │
│  Alert fan-out: Telegram (LIVE) → Email → Discord                │
│  Dedup: counter-based, 3/15min window, P0 bypasses              │
└──────────────────────────────────────────────────────────────────┘
```
