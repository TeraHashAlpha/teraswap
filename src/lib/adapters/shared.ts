import {
  FEE_PERCENT,
  CHAIN_ID,
  WETH_ADDRESS,
  NATIVE_ETH,
} from '@/lib/constants'
import type { Address } from 'viem'

// ── Slippage safety clamp ────────────────────────────────
// Ensures slippage % is always in the safe range [0.01, 15]
// Prevents negative slippage factors when slippage >= 100
// [L-01] Slippage cap reduced from 49.99% to 15% for mainnet safety.
export function clampSlippage(s: number): number {
  return Math.min(Math.max(s, 0.01), 15)
}

// ── Timeout wrapper ──────────────────────────────────────
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms),
    ),
  ])
}

// ── User-friendly error mapping ─────────────────────────
export function friendlyError(source: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()

  // Network-level
  if (lower.includes('failed to fetch') || lower.includes('networkerror'))
    return `${source}: Network error — check your connection.`
  if (lower.includes('timeout'))
    return `${source}: Request timed out. Try again.`

  // HTTP codes
  if (lower.includes('429') || lower.includes('rate limit'))
    return `${source}: Rate limited. Wait a moment and retry.`
  if (lower.includes('403') || lower.includes('forbidden'))
    return `${source}: Access denied — API key may be invalid.`
  if (lower.includes('insufficient') && lower.includes('liquidity'))
    return `${source}: Insufficient liquidity for this pair/amount.`
  if (lower.includes('no route') || lower.includes('no pool'))
    return `${source}: No route found for this pair.`

  // Fallback: first 80 chars
  return `${source}: ${msg.slice(0, 80)}`
}

// ── Token helpers ─────────────────────────────────────────

/** Convert NATIVE_ETH sentinel to WETH for Uniswap */
export function toWeth(token: string): Address {
  return (token.toLowerCase() === NATIVE_ETH.toLowerCase()
    ? WETH_ADDRESS
    : token) as Address
}

export function isNativeEth(token: string): boolean {
  return token.toLowerCase() === NATIVE_ETH.toLowerCase()
}

/** RPC URL for on-chain calls */
export function getRpcUrl(): string {
  return process.env.NEXT_PUBLIC_RPC_URL || 'https://eth.llamarpc.com'
}

/**
 * Deduct platform fee from amountIn.
 * Returns { netAmount (goes to router), feeAmount (platform keeps) }
 */
export function deductFee(amountIn: string): { netAmount: bigint; feeAmount: bigint } {
  const total = BigInt(amountIn)
  // fee = total * FEE_PERCENT / 100
  // Use integer math: fee = total * feeBps / 10000
  const feeBps = BigInt(Math.round(FEE_PERCENT * 100)) // 0.1% -> 10 bps
  const feeAmount = total * feeBps / 10000n
  const netAmount = total - feeAmount
  return { netAmount, feeAmount }
}

// ── Fee tier cache (in-memory, TTL-based) ────────────────
const FEE_TIER_CACHE_TTL_MS = 45 * 60 * 1000 // 45 minutes
export const feeTierCache = new Map<string, { bestFee: number; ts: number }>()

export function feeTierCacheKey(tokenIn: string, tokenOut: string): string {
  return `${CHAIN_ID}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
}

export function getCachedFeeTier(tokenIn: string, tokenOut: string): number | null {
  const key = feeTierCacheKey(tokenIn, tokenOut)
  const entry = feeTierCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > FEE_TIER_CACHE_TTL_MS) {
    feeTierCache.delete(key)
    return null
  }
  return entry.bestFee
}

export function setCachedFeeTier(tokenIn: string, tokenOut: string, bestFee: number): void {
  const key = feeTierCacheKey(tokenIn, tokenOut)
  feeTierCache.set(key, { bestFee, ts: Date.now() })
}

export function invalidateCachedFeeTier(tokenIn: string, tokenOut: string): void {
  feeTierCache.delete(feeTierCacheKey(tokenIn, tokenOut))
}
