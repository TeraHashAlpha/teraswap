/**
 * Seed 10 realistic trades into localStorage analytics for testing.
 * Run this in browser console or via a temporary page component.
 *
 * Usage: Copy-paste into browser console at localhost:3000
 */

const ANALYTICS_STORAGE_KEY = 'teraswap_analytics_events'

function randomHex(bytes: number): string {
  let hex = '0x'
  for (let i = 0; i < bytes; i++) hex += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return hex
}

const now = Date.now()
const HOUR = 3600_000

const trades = [
  // 1. Large ETH → USDC swap via 1inch (30 min ago)
  {
    id: randomHex(32), type: 'swap', wallet: '0x1234567890abcdef1234567890abcdef12345678',
    timestamp: now - 30 * 60_000, hour: new Date(now - 30 * 60_000).getHours(),
    tokenIn: 'ETH', tokenInAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    tokenOut: 'USDC', tokenOutAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountIn: '5.0000', amountOut: '12485.50', volumeUsd: 12485.50, feeUsd: 12.49,
    source: '1inch', txHash: randomHex(32), chainId: 1,
  },
  // 2. USDC → ETH via CoW Protocol (MEV protected, 1h ago)
  {
    id: randomHex(32), type: 'swap', wallet: '0xabcdef1234567890abcdef1234567890abcdef12',
    timestamp: now - HOUR, hour: new Date(now - HOUR).getHours(),
    tokenIn: 'USDC', tokenInAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    tokenOut: 'ETH', tokenOutAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    amountIn: '3500.00', amountOut: '1.4012', volumeUsd: 3500, feeUsd: 3.50,
    source: 'cowswap', txHash: randomHex(32), chainId: 1,
  },
  // 3. ETH → WBTC via Odos (2h ago)
  {
    id: randomHex(32), type: 'swap', wallet: '0x1234567890abcdef1234567890abcdef12345678',
    timestamp: now - 2 * HOUR, hour: new Date(now - 2 * HOUR).getHours(),
    tokenIn: 'ETH', tokenInAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    tokenOut: 'WBTC', tokenOutAddress: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    amountIn: '2.5000', amountOut: '0.0654', volumeUsd: 6242.75, feeUsd: 6.24,
    source: 'odos', txHash: randomHex(32), chainId: 1,
  },
  // 4. DCA buy — ETH → USDC (3h ago)
  {
    id: randomHex(32), type: 'dca_buy', wallet: '0xdeadbeef1234567890abcdef1234567890abcdef',
    timestamp: now - 3 * HOUR, hour: new Date(now - 3 * HOUR).getHours(),
    tokenIn: 'USDC', tokenInAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    tokenOut: 'ETH', tokenOutAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    amountIn: '500.00', amountOut: '0.2001', volumeUsd: 500, feeUsd: 0.50,
    source: 'uniswapv3', txHash: randomHex(32), chainId: 1,
  },
  // 5. Limit order fill — ETH → DAI via CoW (4h ago)
  {
    id: randomHex(32), type: 'limit_fill', wallet: '0xabcdef1234567890abcdef1234567890abcdef12',
    timestamp: now - 4 * HOUR, hour: new Date(now - 4 * HOUR).getHours(),
    tokenIn: 'ETH', tokenInAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    tokenOut: 'DAI', tokenOutAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    amountIn: '1.0000', amountOut: '2497.30', volumeUsd: 2497.30, feeUsd: 2.50,
    source: 'cowswap', txHash: randomHex(32), chainId: 1,
  },
  // 6. SL/TP trigger — LINK → USDC (5h ago)
  {
    id: randomHex(32), type: 'sltp_trigger', wallet: '0x9876543210fedcba9876543210fedcba98765432',
    timestamp: now - 5 * HOUR, hour: new Date(now - 5 * HOUR).getHours(),
    tokenIn: 'LINK', tokenInAddress: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    tokenOut: 'USDC', tokenOutAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountIn: '150.0000', amountOut: '2025.00', volumeUsd: 2025, feeUsd: 2.03,
    source: 'kyberswap', txHash: randomHex(32), chainId: 1,
  },
  // 7. Small ETH → USDT swap via Balancer (6h ago)
  {
    id: randomHex(32), type: 'swap', wallet: '0xfedcba9876543210fedcba9876543210fedcba98',
    timestamp: now - 6 * HOUR, hour: new Date(now - 6 * HOUR).getHours(),
    tokenIn: 'ETH', tokenInAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    tokenOut: 'USDT', tokenOutAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    amountIn: '0.5000', amountOut: '1248.55', volumeUsd: 1248.55, feeUsd: 1.25,
    source: 'balancer', txHash: randomHex(32), chainId: 1,
  },
  // 8. WBTC → ETH via Curve (8h ago)
  {
    id: randomHex(32), type: 'swap', wallet: '0x1234567890abcdef1234567890abcdef12345678',
    timestamp: now - 8 * HOUR, hour: new Date(now - 8 * HOUR).getHours(),
    tokenIn: 'WBTC', tokenInAddress: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    tokenOut: 'ETH', tokenOutAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    amountIn: '0.1000', amountOut: '3.8120', volumeUsd: 9500, feeUsd: 9.50,
    source: 'curve', txHash: randomHex(32), chainId: 1,
  },
  // 9. DCA buy — USDC → UNI via 0x (10h ago)
  {
    id: randomHex(32), type: 'dca_buy', wallet: '0xdeadbeef1234567890abcdef1234567890abcdef',
    timestamp: now - 10 * HOUR, hour: new Date(now - 10 * HOUR).getHours(),
    tokenIn: 'USDC', tokenInAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    tokenOut: 'UNI', tokenOutAddress: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    amountIn: '200.00', amountOut: '25.6410', volumeUsd: 200, feeUsd: 0.20,
    source: '0x', txHash: randomHex(32), chainId: 1,
  },
  // 10. Large whale swap — ETH → USDC via split (OpenOcean, 12h ago)
  {
    id: randomHex(32), type: 'swap', wallet: '0x9876543210fedcba9876543210fedcba98765432',
    timestamp: now - 12 * HOUR, hour: new Date(now - 12 * HOUR).getHours(),
    tokenIn: 'ETH', tokenInAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    tokenOut: 'USDC', tokenOutAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountIn: '20.0000', amountOut: '49942.00', volumeUsd: 49942, feeUsd: 49.94,
    source: 'openocean', txHash: randomHex(32), chainId: 1,
  },
]

// Save to localStorage
const existing = JSON.parse(localStorage.getItem(ANALYTICS_STORAGE_KEY) || '{"version":1,"events":[]}')
existing.events.push(...trades)
localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(existing))

console.log(`✅ Seeded ${trades.length} demo trades. Total: ${existing.events.length}`)
console.log('Trades:', trades.map(t => `${t.type}: ${t.amountIn} ${t.tokenIn} → ${t.amountOut} ${t.tokenOut} ($${t.volumeUsd}) via ${t.source}`))
