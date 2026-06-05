# ADR-007 — TeraSwap as Morpho Vault Curator

**Status:** Proposed
**Date:** 2026-05-18
**Author:** TeraHash (Architect)
**Target Phase:** Phase 4 (Protocol & Community) — earliest Q3/Q4 2026
**Depends on:** P68 (FeeCollector V2 deploy), Phase 2 (multi-chain), ADR-006 (surplus data)

---

## Context

Morpho is a permissionless lending protocol that introduced the "curator" model
in V1 — independent entities that create and manage non-custodial vaults,
defining investment strategies, selecting lending markets, and overseeing risk
frameworks. Curators never have custody of user funds; execution is automated
and transparent via smart contracts.

The curator ecosystem is growing rapidly in 2026: Bitwise launched a USDC vault
targeting ~6% yield, Sentora manages $300M in PYUSD for PayPal, and dozens of
other teams operate as curators. Morpho V2 is expanding curator freedom further.

Paul Frambot (Morpho CEO) has highlighted that curators are shipping
aggressively, with institutional adoption accelerating. The barrier to entry is
technical competence + risk management — not capital or licensing (yet).

TeraSwap, as a meta-aggregator with 11 liquidity sources, multi-oracle
validation, and real-time market intelligence, has a natural advantage as a
vault curator.

## Decision

Evaluate and plan for TeraSwap to become a Morpho vault curator, offering
yield-generating vaults that leverage our existing infrastructure.

## Rationale

### Strategic fit

1. **Revenue diversification** — Today TeraSwap earns 0.1% per swap via
   FeeCollector. A vault adds a second revenue stream: curator fees
   (typically 5-15% of vault yield). These are complementary — swap fees are
   transactional, vault fees are recurring (AUM-based).

2. **User stickiness** — "Swap and earn" keeps assets in the TeraSwap
   ecosystem instead of users moving output to Aave/Compound manually.
   Reduces churn, increases TVL narrative.

3. **Existing infrastructure synergy:**
   - Chainlink + DefiLlama oracles → collateral quality assessment
   - 11 DEX real-time monitoring → liquidity depth intelligence
   - Post-execution validator → surplus tracking feeds yield optimization
   - FeeCollector V3 surplus capture → can redirect to vault as bonus yield

4. **Multi-chain alignment** — Morpho operates on Ethereum Mainnet + Base.
   Our Phase 2 targets Arbitrum + Base. Shared chain deployment.

### Product concepts

**Concept A — Stablecoin yield vault (conservative)**
- USDC/DAI deposits → allocated to highest risk-adjusted Morpho markets
- Target: 3-6% APY, stablecoin-only collateral markets
- Risk framework: max 30% per single market, Chainlink oracle mandatory,
  minimum liquidity thresholds
- Revenue: 10% performance fee on yield

**Concept B — "Swap & earn" integration**
- After a swap, user can opt-in to deposit output token into a TeraSwap vault
- Idle assets generate yield until user withdraws or initiates next swap
- One-click "withdraw + swap" flow
- UX: toggle in SwapBox "Auto-earn on idle balance"

**Concept C — DCA yield buffer**
- DCA orders waiting for execution sit in a Morpho vault
- Between DCA chunks, capital earns yield
- On execution: withdraw chunk → swap via TeraSwap → deposit remaining back
- Requires OrderExecutor V3 integration with vault withdraw

### Competitive advantage as curator

| Capability | Most curators | TeraSwap |
|-----------|--------------|----------|
| Oracle validation | Single source | Multi-oracle (Chainlink + DefiLlama + cross-quote) |
| Liquidity intelligence | Manual research | Real-time 11-DEX monitoring |
| Swap execution | External | Native meta-aggregation (best price) |
| Surplus tracking | None | ADR-006 instrumentation in place |
| User base | Separate acquisition | Existing swap users (organic funnel) |

## Risks

### Technical
- **Smart contract risk** — vault interaction adds attack surface. Morpho
  contracts are audited but integration bugs are possible.
- **Oracle dependency** — vault rebalancing decisions depend on oracle
  accuracy. Our multi-oracle setup mitigates but doesn't eliminate.
- **Gas costs** — vault deposits/withdrawals add gas. Must be economical
  relative to yield earned.

### Operational
- **Active management required** — curators must monitor markets, adjust
  allocations, respond to market events. Not set-and-forget.
- **Reputational** — if the vault underperforms or loses funds (even from
  Morpho market risk, not our fault), it damages TeraSwap brand.
- **Capacity** — single-developer project. Vault management is a new
  ongoing responsibility.

### Regulatory
- **Evolving landscape** — curators may face regulatory oversight as the
  role professionalizes. Monitor MiCA and SEC guidance.
- **Not a fund manager** — non-custodial nature is a defense, but
  "managing a vault" could be interpreted as investment advice in some
  jurisdictions.

### Financial
- **Minimum viable TVL** — vault only generates meaningful revenue at
  >$1M TVL. At $1M × 5% yield × 10% fee = $5K/year. Need >$10M for it
  to matter.
- **Bootstrapping** — initial TVL will be low. May need incentives or
  partnerships to reach critical mass.

## Prerequisites (before build)

1. **FeeCollector V2 deployed** (P68) — hardened contract on mainnet
2. **Phase 2 multi-chain** — at minimum Base support (Morpho's second chain)
3. **ADR-006 30-day data** — validates swap volume and surplus magnitudes
4. **Gnosis Safe multisig** — vault admin operations require proper key
   management
5. **Risk framework document** — formal criteria for market selection,
   exposure limits, rebalancing triggers
6. **Legal review** — basic assessment of curator liability in PT/EU context

## Implementation sketch (high-level)

### Phase A — Research & framework (0.5 pw)
- Study Morpho Vault V1 docs + V2 preview
- Define risk framework (market selection criteria, exposure caps)
- Deploy test vault on Sepolia/Base testnet with minimal capital
- Document curator operational procedures

### Phase B — MVP vault (1.5 pw)
- Deploy stablecoin vault on mainnet (Concept A)
- Conservative parameters: USDC only, 3 markets max, 30% cap per market
- Monitoring: Telegram alerts for allocation changes, yield drops, market events
- No frontend integration yet — vault is standalone, accessible via Morpho UI

### Phase C — Swap integration (2 pw)
- "Swap & earn" toggle in SwapBox (Concept B)
- Vault deposit/withdraw wired into useSwap flow
- Dashboard: vault balance, yield earned, allocation breakdown
- Gas estimation for deposit/withdraw included in swap quote

### Phase D — DCA integration (1.5 pw)
- OrderExecutor V3: vault-aware DCA (Concept C)
- Automatic deposit idle DCA capital, withdraw per chunk
- Yield attribution per DCA order

## Decision criteria

Move to **Accepted** when ALL of:
- P68 deployed and stable for 30 days
- ADR-006 data shows >$50K monthly swap volume
- Risk framework document reviewed by external party
- Legal assessment completed
- At least one other revenue stream besides swap fees justifies operational cost

Move to **Rejected** if:
- Swap volume insufficient (<$10K/month after 90 days)
- Regulatory clarity makes curator role untenable
- Morpho V2 changes make curator economics unviable

## References

- [Morpho Curators Explained](https://morpho.org/blog/curators-explained/)
- [Morpho 2026 Roadmap](https://morpho.org/blog/morpho-2026/)
- [Create a Vault — Morpho Docs](https://docs.morpho.org/morpho-vaults/tutorials/become-a-curator/creation/)
- [Vault Concept — Morpho Docs](https://docs.morpho.org/learn/concepts/vault/)
- [Curator Concept — Morpho Docs](https://docs.morpho.org/learn/concepts/curator/)
- ADR-006 — Positive Slippage Sharing (surplus data dependency)
- PREAUDIT-REMEDIATION-REPORT.md (V2 contract security baseline)
