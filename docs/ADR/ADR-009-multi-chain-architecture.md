# ADR-009: Multi-Chain Architecture

**Status:** Proposed  
**Date:** 2026-05-29  
**Author:** Architect  
**Context:** Phase 2 — Base L2 as first expansion chain

---

## Decision

Adopt a **ChainConfig registry** pattern for multi-chain support. Each chain is a self-contained configuration object. All chain-specific logic (RPC endpoints, contract addresses, Chainlink feeds, adapter URLs, gas model) is resolved via the registry, not hardcoded.

### Chain priority

1. **Base** (chainId 8453) — first L2, swap aggregation only
2. **Arbitrum** (chainId 42161) — second L2, swap + order engine
3. **Polygon** (chainId 137) — third, if demand warrants

### Architecture

```
ChainConfig (per chain)
├── chainId: number
├── name: string
├── slug: string (for API paths: 'ethereum', 'base', 'arbitrum')
├── rpc: { primary: string, fallbacks: string[] }
├── nativeCurrency: { symbol, decimals, wrapped }
├── contracts: { feeCollector, permit2, cowVaultRelayer, ... }
├── chainlinkFeeds: Record<tokenAddress, feedAddress>
├── sequencerUptimeFeed?: string (L2 only)
├── adapterConfig: Record<AdapterName, { baseUrl, chainParam }>
├── blockExplorer: string
├── gasModel: 'eip1559' | 'op-stack' (affects estimation)
└── tokens: { weth, usdc, usdt, dai, ... } (per-chain addresses)
```

### Key decisions

1. **Registry, not inheritance.** Each chain config is a plain object in a typed Map. No class hierarchy, no chain "mixins." Simple, testable, serializable.

2. **Adapter URL parameterization.** Each adapter resolves its API URL via `adapterConfig[source].baseUrl` + chain-specific parameters. Five patterns identified:
   - Path segment: 1inch (`/v6.0/{chainId}`), KyberSwap (`/{slug}`), CoW (`/{slug}/api/v1`), OpenOcean (`/v4/{chainId}`), SushiSwap (`/swap/v7/{chainId}`)
   - Query/body param: 0x (`chainId=`), Odos (`chainId:` in body), Velora (`network` param), Balancer (`chainId` param)
   - On-chain: Uniswap V3, Curve (contract addresses per chain)

3. **Sequencer uptime check (L2 mandatory).** Before any Chainlink price read on an L2 chain, check the sequencer uptime feed. If sequencer is down or recently recovered (grace period), reject the price as stale. This is a standard L2 DeFi security requirement.

4. **OP Stack gas estimation.** Base fees have an L1 data cost component. `viem` handles this transparently via `estimateGas` on Base RPCs, but the gas display in UI needs to account for both components.

5. **Per-chain token addresses.** Same token (e.g., USDC) has different contract addresses on different chains. Token lists are per-chain. The token selector must be chain-aware.

6. **FeeCollector per chain.** Each chain needs its own FeeCollector deployment. Router whitelist is chain-specific (different router addresses per chain).

7. **Mainnet unchanged.** All existing mainnet logic continues to work exactly as before. Multi-chain is additive — no changes to existing code paths when `chainId === 1`.

### Alternatives considered

- **Chain inheritance (rejected):** `BaseChain extends EthereumChain` — too rigid, L2 quirks don't map to inheritance.
- **Single global config with chain switch (rejected):** Mutation-based, error-prone, can't serve two chains simultaneously.
- **Separate deployment per chain (rejected):** Duplicate codebase, maintenance nightmare.

### Risks

- **Adapter differences:** Some adapters may behave slightly differently on Base (rate limits, available pairs, response format). Need per-adapter testing.
- **Chainlink feed coverage:** Base has fewer feeds than mainnet. Some tokens may not have price feeds on Base.
- **Odos V3 migration:** Odos is retiring V2 API. May need V3 integration alongside V2.

---

## Consequences

- Every chain-specific value goes through `getChainConfig(chainId)` — no hardcoded chain assumptions anywhere
- New chains (Arbitrum, Polygon) become config-only additions: add a `ChainConfig` entry, deploy contracts, add Chainlink feeds
- Test suite must cover per-chain config resolution
- ADR-009 supersedes: nothing (first multi-chain decision)
