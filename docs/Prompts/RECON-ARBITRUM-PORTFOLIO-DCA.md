# RECON — Arbitrum Portfolio + DCA enabled-cost inventory

> **What this is.** A measured inventory of what Portfolio and DCA would need to support Arbitrum (42161) — not estimates, not "here's what code should look like", but the actual gaps read from the repo. Purpose: let the Architect decide on priorities + ordering before anyone writes code. The last chain-awareness gap cost an incident; this is its prevention.

---

## 1. Portfolio — token discovery (ALCHEMY endpoint)

**What EXACTLY must be added for 42161 — token discovery path:**

File: `src/lib/portfolio-chains.ts:19-22`

```typescript
export const ALCHEMY_BASE_BY_CHAIN: Record<number, string> = {
  1: 'https://eth-mainnet.g.alchemy.com/v2',
  8453: 'https://base-mainnet.g.alchemy.com/v2',
}
```

**Required addition:** Add 42161 key with its Alchemy Enhanced-API endpoint URL (format: `https://arb-mainnet.g.alchemy.com/v2`).

**Is 42161 registered in chains/registry.ts with a DefiLlama slug?**

File: `src/lib/chains/registry.ts:107-109`

```typescript
const ARBITRUM: ChainConfig = {
  chainId: 42161,
  name: 'Arbitrum One',
  slug: 'arbitrum',
```

**YES** — 42161 is registered (line 174: `42161: ARBITRUM,`), and the slug is `'arbitrum'` (line 110).

---

## 2. Portfolio — the rest of the path (chain-specific branches)

File: `src/app/api/portfolio/tokens/route.ts:52`

```typescript
const list = chainId === DEFAULT_CHAIN_ID ? DEFAULT_TOKENS : getChainTokenList(chainId)
```

File: `src/app/api/portfolio/prices/route.ts:98`

```typescript
const chainSlug = getChainConfig(chainId).slug
```

**Complete list of chain-specific branching beyond the Alchemy endpoint map:**

1. **Line 52 (tokens/route.ts)**: Curated tokens branch on `DEFAULT_CHAIN_ID`. Mainnet uses `DEFAULT_TOKENS`; other chains (including 42161 if added) call `getChainTokenList(chainId)`, which reads from the generated catalog. No hardcoded 42161 assumption; the branching will work.
2. **Line 98 (prices/route.ts)**: Gets slug from registry via `getChainConfig(chainId)`. No hardcoding; 42161 already has slug `'arbitrum'` in registry, so this resolves correctly.
3. **Both routes validate chainId against `isPortfolioSupportedChain(chainId)`**, which reads from `ALCHEMY_BASE_BY_CHAIN`. Adding 42161 there updates the allowlist for both routes automatically.

**Additional chain-specific operations:** None beyond the map + registry lookup. The portfolio routes are chain-aware-generic; no hardcoded chain assumptions found.

---

## 3. Portfolio — token catalog

**Does the catalog pipeline already know about 42161?**

File: `scripts/token-catalog/lib/config.ts:22-24`

```typescript
export const PIPELINE_CONFIG: PipelineConfig = {
  chains: [1, 8453],
```

**NO** — the pipeline config lists only chains 1 and 8453. 42161 is not in the pipeline.

**Does a generated catalog for 42161 exist in the repo?**

**NO** — no file at `src/config/generated/token-catalog.42161.json`.

**What produces one, and is it a config entry or new code?**

**Config entry only.** To add 42161 to the pipeline:

1. Add `42161` to `chains` array (line 23 above)
2. Add an entry to `maxNewTokensPerChain` (line 28): `42161: <limit>`
3. Add Arbitrum's CORE_TOKENS to `CORE_TOKENS` record (line 37+): the ones already defined in `src/lib/chains/registry.ts:145-168` (WETH, USDC, USDT, DAI, WBTC)

The build script `npm run tokens:sync` will then generate `src/config/generated/token-catalog.42161.json` and include it in the PR. No new code required — the fetchers already handle arbitrary chain IDs via DefiLlama slug resolution (which 42161 has: `'arbitrum'`).

---

## 4. DCA — the blocking fact (OrderExecutor deployment)

**Is there NO OrderExecutor V3 deployed on Arbitrum, or was one never wired?**

File: `src/lib/order-engine/config.ts:60-67`

```typescript
export const ORDER_EXECUTOR_V3_BY_CHAIN: Record<number, `0x${string}` | null> = {
  1: (process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS || null) as `0x${string}` | null,
  8453: (process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE || null) as `0x${string}` | null,
  42161: (process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM || null) as `0x${string}` | null,
}
```

**The answer: UNVERIFIED from the repo alone.** The code entry exists (line 66) and a slot was populated in Vercel from 2026-08-04 to 2026-08-26, making DCA reachable on Arbitrum in production during that window. Whether a contract is actually deployed at that address is not documented in the repo and requires on-chain verification. *(Superseded by INC-2026-08-26-001)*

**Any Arbitrum executor address found in the repo?**

File: `docs/Runbooks/ARBITRUM-V3-EXECUTOR-DEPLOY.md` exists — a comprehensive runbook for deploying it. However, it is a PRE-DEPLOY runbook (specifies arguments, not a deployed address). No deployed address found anywhere in the repo (no broadcast artifact, no DEPLOYMENTS.md entry for V3 on Arbitrum, no ADR).

**What is known:** The environment variable slot was populated in Vercel from 2026-08-04 to 2026-08-26 (INC-2026-08-26-001), and DCA was reachable on Arbitrum in production during that window. The config slot is ready and the runbook is written. Whether the contract exists on-chain at that address is unverified from the repo alone and requires on-chain inspection. *(Superseded by INC-2026-08-26-001)*

---

## 5. Chainlink — the 42161 feeds block

File: `src/lib/chains/chainlink-feeds.ts:47-70`

```typescript
// CONFIG-ONLY / dark: unreachable while contracts.feeCollector is null (isChainActive(42161) === false).
42161: {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', // WETH → ETH/USD
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3', // USDC → USDC/USD
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB', // DAI → DAI/USD
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7', // USDT → USDT/USD
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': '0xd0C7101eACbB49F3deCcCc166d238410D6D46d57', // WBTC → WBTC/USD
},
```

**5 feeds are configured for 42161:**

1. ETH/USD: `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612`
2. USDC/USD: `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3`
3. DAI/USD: `0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB`
4. USDT/USD: `0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7`
5. WBTC/USD: `0xd0C7101eACbB49F3deCcCc166d238410D6D46d57`

**Why is this block unreachable?**

Line 55-56: `CONFIG-ONLY / dark: unreachable while contracts.feeCollector is null (isChainActive(42161) === false).`

The feeds themselves are verified on-chain and on data.chain.link, but they're not USABLE by the app until `isChainActive(42161)` becomes true, which requires `contracts.feeCollector` for 42161 to be non-null in `chains/registry.ts` (line 124). While feeCollector is null, the chain is considered inactive and Chainlink price lookups won't execute.

---

## 6. The gap between Portfolio and DCA

**Which is a config change, which needs something that doesn't exist yet?**

- **Portfolio: CONFIG CHANGE.** Add Alchemy endpoint for 42161 to `ALCHEMY_BASE_BY_CHAIN`, add 42161 to token-catalog pipeline config, and optionally add curated Base-analog seeds for Arbitrum. The registry entry (slug, contracts, tokens) is already there. Everything else is database/config entries.

- **DCA: DEPLOYMENT UNVERIFIED.** A slot for OrderExecutorV3 on Arbitrum One (42161) was populated in Vercel from 2026-08-04 to 2026-08-26, and DCA was reachable on Arbitrum in production during that window. The code is ready (wired in ORDER_EXECUTOR_V3_BY_CHAIN, runbook written), but whether the smart contract is actually deployed on-chain at that address is not documented in the repo and requires on-chain verification. *(Superseded by INC-2026-08-26-001)*

---

## What is NOT known

- **Arbitrum Alchemy endpoint exact URL** — format inferred as `https://arb-mainnet.g.alchemy.com/v2` but not confirmed in docs/Runbooks.
- **OrderExecutorV3 deployment status on mainnet Arbitrum** — runbook exists (ARBITRUM-V3-EXECUTOR-DEPLOY.md) but no confirmation of whether it has been executed. A search for any deployed V3 address returned nothing, so either: (a) not deployed yet, or (b) deployed but address not documented in the repo (only .env secret).
- **Token catalog seeding strategy for Arbitrum** — whether CURATED_BASE_SEEDS has an Arbitrum analog, or if Arbitrum should inherit from seed-baseline only, is not documented in this config file.
- **FeeCollector deployment status on Arbitrum** — registry.ts shows env-driven null, and docs/DEPLOYMENTS.md line 11 mentions it WAS deployed (2026-07-20), but this recon is read-only and cannot verify the env var state or whether go-live has flipped it.

(Count: 4 items)
