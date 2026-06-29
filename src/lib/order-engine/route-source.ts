/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] Committed-router → aggregator-source mapping, shared with the
 * analytics route (#228). A Base DCA order routes through Augustus V6 → "velora" → badge "Velora".
 *
 * MUST mirror contracts/order-engine/executor/swap-route.js `ROUTER_SOURCE` and the per-chain
 * whitelist in src/lib/order-engine/config.ts. Keyed lowercased (router addresses are globally unique
 * → chain-agnostic).
 */

export const ROUTER_TO_SOURCE: Record<string, string> = {
  // Base (8453)
  '0x6a000f20005980200259b80c5102003040001068': 'velora',     // ParaSwap/Velora Augustus V6
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'uniswapv3',  // Uniswap SwapRouter02
  // Mainnet (1)
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch',      // 1inch v6
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x',         // 0x Exchange Proxy
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'velora',     // Augustus v5 (ParaSwap) → velora
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'uniswapv3',  // Uniswap V3 SwapRouter
}

/** Friendly display labels for the route badge. */
const SOURCE_LABEL: Record<string, string> = {
  velora: 'Velora',
  uniswapv3: 'Uniswap V3',
  '1inch': '1inch',
  '0x': '0x',
}

/** The aggregator source name for a committed router address, or null if unknown. */
export function sourceForRouter(router: string | null | undefined): string | null {
  if (!router) return null
  return ROUTER_TO_SOURCE[router.toLowerCase()] ?? null
}

/** A friendly route-badge label for a router address — never blank ("Aggregated" fallback). */
export function routeLabel(router: string | null | undefined): string {
  const source = sourceForRouter(router)
  if (!source) return 'Aggregated'
  return SOURCE_LABEL[source] ?? source
}
