/**
 * Health check probes for monitored endpoints.
 *
 * Two modes:
 *   - Aggregator: sends a minimal quote request (USDC→USDT, 1 unit)
 *   - Self: HEAD request to teraswap.app
 *
 * TLS cert capture is deferred to a dedicated tls.connect call
 * (only when baseline comparison is needed, not every tick).
 */

import type { MonitoredEndpoint } from './monitored-endpoints'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const PROBE_AMOUNT = '1000000' // 1 USDC (6 decimals)
const TIMEOUT_MS = 8_000

export interface HealthCheckResult {
  ok: boolean
  latencyMs: number
  error?: string
}

/**
 * Run a health check for a single endpoint.
 */
export async function runHealthCheck(endpoint: MonitoredEndpoint): Promise<HealthCheckResult> {
  const start = Date.now()

  try {
    if (endpoint.id === 'teraswap-self') {
      return await checkSelf(endpoint.hostname, start)
    }
    return await checkAggregator(endpoint, start)
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** HEAD request to our own domain */
async function checkSelf(hostname: string, start: number): Promise<HealthCheckResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(`https://${hostname}/`, {
      method: 'HEAD',
      signal: controller.signal,
    })
    clearTimeout(timer)

    return {
      ok: res.status >= 200 && res.status < 400,
      latencyMs: Date.now() - start,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    }
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

/** Minimal quote request to an aggregator API */
async function checkAggregator(endpoint: MonitoredEndpoint, start: number): Promise<HealthCheckResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  // Build a minimal probe URL based on the aggregator's known API pattern
  const url = buildProbeUrl(endpoint)
  if (!url) {
    clearTimeout(timer)
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: `No probe URL configured for ${endpoint.id}`,
    }
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })
    clearTimeout(timer)

    // Any response (even 400) means the endpoint is reachable.
    // Only network errors, timeouts, and 5xx count as failures.
    const ok = res.status < 500

    return {
      ok,
      latencyMs: Date.now() - start,
      error: ok ? undefined : `HTTP ${res.status}`,
    }
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

/**
 * Build a lightweight probe URL for each aggregator.
 * These are GET-only, minimal requests that don't consume API quotas aggressively.
 */
function buildProbeUrl(endpoint: MonitoredEndpoint): string | null {
  switch (endpoint.id) {
    case '1inch':
      // 1inch quote endpoint (requires API key — may return 401, which is still "reachable")
      return `https://api.1inch.dev/swap/v6.0/1/quote?src=${USDC}&dst=${USDT}&amount=${PROBE_AMOUNT}`

    case '0x':
      return `https://api.0x.org/swap/v1/price?sellToken=${USDC}&buyToken=${USDT}&sellAmount=${PROBE_AMOUNT}`

    case 'paraswap':
      return `https://api.paraswap.io/prices?srcToken=${USDC}&destToken=${USDT}&amount=${PROBE_AMOUNT}&srcDecimals=6&destDecimals=6&network=1`

    case 'odos':
      // Odos uses POST for quotes — use a simple GET to their health/info endpoint
      return `https://api.odos.xyz/info/chains`

    case 'kyberswap':
      return `https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=${USDC}&tokenOut=${USDT}&amountIn=${PROBE_AMOUNT}`

    case 'cowswap':
      return `https://api.cow.fi/mainnet/api/v1/quote`  // Will 405 on GET — but reachable

    case 'openocean':
      return `https://open-api.openocean.finance/v4/1/quote?inTokenAddress=${USDC}&outTokenAddress=${USDT}&amount=1`

    case 'sushiswap':
      return `https://api.sushi.com/swap/v7/1`  // Health endpoint

    case 'balancer':
      return `https://api-v3.balancer.fi/`

    default:
      return null
  }
}
