/**
 * [CHORE-47C-ARBITRUM-CATALOG] Arbitrum One (42161) launch token catalog — plain data.
 *
 * Closes AUDIT-ARBITRUM-46-47 M-01: `CHAIN_TOKENS[42161]` was empty, so the Arbitrum token
 * selector had nothing to show and the deploy runbook's Preview smoke (WETH→USDC) had no
 * catalog to draw from. Strictly additive — the chain stays DARK (feeCollector env unset,
 * `isChainActive(42161) === false`); populating the catalog does not activate swaps.
 *
 * Addresses + decimals come ONLY from `arbitrum-catalog.generated.ts` (itself generated from
 * `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` by `scripts/generate-arbitrum-catalog.mjs`) —
 * zero hex literals are typed into this file, per [[feedback_address_hygiene]]. This module is
 * intentionally dependency-free of `./tokens` (which imports FROM here) to avoid a circular
 * import; the final `ChainToken` shaping (logo, popular/suggested flags) happens in tokens.ts,
 * mirroring the existing BASE_FULL pattern there.
 *
 * Launch set = the 5 Chainlink-feed-covered manifest tokens (owner decision, L-01
 * adjudication: launch set ⊆ feed-covered set): WETH, USDC (native), USDT, DAI, WBTC.
 * wstETH is intentionally DEFERRED — it has no Chainlink feed entry in the manifest, so it
 * falls outside the feed-covered launch set. Do not add it here without a new activation
 * decision + a corresponding feed addition.
 *
 * USDT0 note: the manifest's `USDT` entry resolves on-chain to `symbol() = "USD₮0"` (Tether's
 * newer LayerZero omnichain standard — the dominant USDT-pegged token on Arbitrum by trading
 * volume, per CHORE-47B). The catalog key/symbol shown to users stays `USDT` for continuity
 * with mainnet/Base; the `symbolMismatchExempt` entry in `catalog-guard.allowlist.json` pins
 * this so the identity guard doesn't flag it as a typo/swap.
 */
import { ARBITRUM_MANIFEST_TOKENS, type ArbitrumManifestToken } from './arbitrum-catalog.generated'

export interface ArbitrumCatalogEntry extends ArbitrumManifestToken {
  name: string
}

const DISPLAY_NAME: Record<string, string> = {
  WETH: 'Wrapped Ether',
  USDC: 'USD Coin',
  USDT: 'Tether USD',
  DAI: 'Dai Stablecoin',
  WBTC: 'Wrapped BTC',
}

export const ARBITRUM_CATALOG: ArbitrumCatalogEntry[] = ARBITRUM_MANIFEST_TOKENS.map((t) => ({
  ...t,
  name: DISPLAY_NAME[t.key] ?? t.key,
}))
