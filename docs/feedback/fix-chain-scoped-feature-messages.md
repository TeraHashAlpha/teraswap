## Feedback — fix/chain-scoped-feature-messages

### Shipped copy

**DCA — no order-engine executor for the chain** (`data-testid="dca-chain-unavailable"`, new):
> **DCA is not available on {chain name} yet.** The order engine does not have an executor deployed on this chain.

`{chain name}` = `getChainConfig(chainId).name` (registry `src/lib/chains/registry.ts`), e.g. "Arbitrum One". Falls back to
the neutral phrase "this chain" (not a hardcoded chain name) if the connected chain has no registry entry at all.

**DCA — Chainlink feed unreadable** (`data-testid="dca-oracle-block"`, UNCHANGED):
> **DCA blocked — price could not be verified.** {oracleGate.detail} This is a problem on our side with the Chainlink
> price feed for this pair — not a finding about {token}, and not a sign the price moved. …

**Portfolio — chain not in the discovery allowlist** (`data-testid="portfolio-chain-unavailable"`, new):
> Portfolio isn't available on {chain name} yet.

**Portfolio — empty wallet, chain IS supported** (existing element, string fixed):
> No tokens found in this wallet on {chain name}.

(previously hardcoded "No tokens found in this wallet on Ethereum mainnet." regardless of the selected chain)

### Confirmation

The Base DCA price-verification path (`oracleBlocked = v3Enabled && oracleGate.blocked`) is untouched — the new
`dca-chain-unavailable` banner is gated on `!v3Enabled`, which is mutually exclusive with `oracleBlocked` by
construction (that variable already requires `v3Enabled` to be true). `DCAPanel.oracle-fail-closed.test.tsx` and
`DCAPanel.v3.test.tsx` (Base-only suites) pass unmodified against the new code. No gate, guard, `canCreate`, or
`handleCreate` logic was touched.

### Edge case

- The prompt scoped files to `DCAPanel.tsx` / `PortfolioTab.tsx` / registry files (read-only), but preventing the
  Portfolio 400 required a change in `src/hooks/usePortfolio.ts` too: `PortfolioTab` calls `usePortfolio()`
  unconditionally (React hook rules — it can't be called only when the chain is supported), so the fetch guard has
  to live inside the hook's effect, not the component. Added `isPortfolioSupportedChain(chainId)` check there
  (skips the `/api/portfolio/tokens` fetch entirely for an unsupported chain) and a new `isChainSupported` field on
  `PortfolioData` that `PortfolioTab` reads to render the availability state instead of the loading/error/empty
  branches. `usePortfolio.ts` is not in the "Files affected" list but has no other seam that could stop the request.

### Test gap

- Neither `getChainConfig` fallback branch (`'this chain'`) is exercised by a test — every chain reachable through
  `DCA_CHAINS` / `PORTFOLIO_SUPPORTED_CHAINS` today has a registry entry, so the catch branch is unreachable in
  practice and only defends against a future drift between those allowlists and `CHAIN_CONFIGS`.
