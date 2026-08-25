/**
 * Endpoints monitored for TLS certificate and DNS integrity.
 * Used by scripts/capture-endpoint-baseline.ts and future H2 watcher.
 *
 * Only includes endpoints with HTTPS API calls — on-chain adapters
 * (Curve, Uniswap V3) use RPC and are not monitored here.
 */

export interface MonitoredEndpoint {
  id: string
  hostname: string
  /** Optional: expected certificate issuer CN for validation */
  expectedIssuerCN?: string
  /** true for own domain + top aggregators by volume */
  critical: boolean
}

export const MONITORED_ENDPOINTS: MonitoredEndpoint[] = [
  // ── TeraSwap own domain ──
  { id: 'teraswap-self', hostname: 'www.teraswap.app', critical: true },

  // ── Aggregator API endpoints (from src/lib/constants.ts AGGREGATOR_APIS) ──
  { id: '1inch',     hostname: 'api.1inch.dev',                        critical: true },
  { id: '0x',        hostname: 'api.0x.org',                           critical: true },
  { id: 'paraswap',  hostname: 'api.paraswap.io',                      critical: true },
  // odos removed 2026-08-04: vendor ceased ALL operations 2026-07-30 (company
  // shutdown, permanent — see DISABLED_SOURCES.odos in constants.ts). Unlike
  // balancer/openocean/sushiswap below (disabled but theoretically fixable,
  // kept non-critical so a hijack of a still-operated domain still pages), a
  // shuttered vendor's domain is not worth TLS/DNS-integrity monitoring: no
  // quote traffic ever depends on it again, and a repurposed/hijacked dead
  // domain returning 200s again is exactly what would wrongly re-page this
  // as reachable.
  { id: 'kyberswap', hostname: 'aggregator-api.kyberswap.com',         critical: true },
  { id: 'cowswap',   hostname: 'api.cow.fi',                           critical: true },
  { id: 'openocean', hostname: 'open-api.openocean.finance',           critical: false },
  { id: 'sushiswap', hostname: 'api.sushi.com',                        critical: false },
  { id: 'balancer',  hostname: 'api-v3.balancer.fi',                   critical: false },

  // ── Note: Curve and Uniswap V3 are on-chain (RPC), no API host to monitor ──
]
