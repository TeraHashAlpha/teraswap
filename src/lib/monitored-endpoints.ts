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
  { id: 'teraswap-self', hostname: 'teraswap.app', critical: true },

  // ── Aggregator API endpoints (from src/lib/constants.ts AGGREGATOR_APIS) ──
  { id: '1inch',     hostname: 'api.1inch.dev',                        critical: true },
  { id: '0x',        hostname: 'api.0x.org',                           critical: true },
  { id: 'paraswap',  hostname: 'api.paraswap.io',                      critical: true },
  { id: 'odos',      hostname: 'api.odos.xyz',                         critical: true },
  { id: 'kyberswap', hostname: 'aggregator-api.kyberswap.com',         critical: true },
  { id: 'cowswap',   hostname: 'api.cow.fi',                           critical: true },
  { id: 'openocean', hostname: 'open-api.openocean.finance',           critical: false },
  { id: 'sushiswap', hostname: 'api.sushi.com',                        critical: false },
  { id: 'balancer',  hostname: 'api-v3.balancer.fi',                   critical: false },

  // ── Note: Curve and Uniswap V3 are on-chain (RPC), no API host to monitor ──
]
