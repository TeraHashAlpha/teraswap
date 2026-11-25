/**
 * [ADR-029, details B and C] What POST and PATCH /api/log-swap take from a request body.
 *
 * POST keeps only what a private pending row needs, each value checked: the wallet, the chain, the source (a name of
 * the app's list), the two token ADDRESSES, the two declared amounts (decimal digits), and four numbers and flags of the
 * row. It never reads the caller's status, USD amounts, fee amount, oracle fields, mev fields or symbol text.
 * PATCH takes the transaction hash and the wallet, and nothing else.
 */
import { TX_HASH_RE, isSwapLogChain, isSwapLogSource } from '@/lib/swap-verify/verify-swap-on-chain'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
/** A raw token amount: decimal digits, at most 78 (the length of 2^256 - 1). */
const AMOUNT_RE = /^\d{1,78}$/

export interface PendingSwapInput {
  wallet: string
  chainId: number
  source: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  slippage: number
  mevProtected: boolean
  feeCollected: boolean
  expectedOutput: string | null
  gasSavingsUsd: number
  /** Sent by the split-swap client with its POST: handled as a PATCH after the insert. */
  txHash: string | null
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error })

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== ''
}

export function parsePendingSwap(body: unknown): Parsed<PendingSwapInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('Missing required fields')
  const b = body as Record<string, unknown>

  for (const field of ['wallet', 'source', 'tokenIn', 'tokenOut', 'amountIn', 'amountOut']) {
    if (!isPresent(b[field])) return bad('Missing required fields')
  }

  if (typeof b.wallet !== 'string' || !ADDRESS_RE.test(b.wallet)) return bad('Invalid wallet')
  if (!isSwapLogSource(b.source)) return bad('Invalid source')
  // The native placeholder the app uses (0xEeee…EEeE) has the shape of an address, so it passes here as it is.
  if (typeof b.tokenIn !== 'string' || !ADDRESS_RE.test(b.tokenIn)) return bad('Invalid tokenIn')
  if (typeof b.tokenOut !== 'string' || !ADDRESS_RE.test(b.tokenOut)) return bad('Invalid tokenOut')
  if (typeof b.amountIn !== 'string' || !AMOUNT_RE.test(b.amountIn)) return bad('Invalid amountIn')
  if (typeof b.amountOut !== 'string' || !AMOUNT_RE.test(b.amountOut)) return bad('Invalid amountOut')

  // As before, a missing chain id means Ethereum; one that is sent must be a chain of the app.
  const chainId = b.chainId === undefined || b.chainId === null ? 1 : b.chainId
  if (!isSwapLogChain(chainId)) return bad('Invalid chainId')

  let txHash: string | null = null
  if (isPresent(b.txHash)) {
    if (typeof b.txHash !== 'string' || !TX_HASH_RE.test(b.txHash)) return bad('Invalid txHash')
    txHash = b.txHash.toLowerCase()
  }

  const slippage = typeof b.slippage === 'number' && Number.isFinite(b.slippage) && b.slippage >= 0 && b.slippage <= 100 ? b.slippage : 0.5
  const source = b.source

  return {
    ok: true,
    value: {
      wallet: b.wallet.toLowerCase(),
      chainId,
      source,
      tokenIn: b.tokenIn.toLowerCase(),
      tokenOut: b.tokenOut.toLowerCase(),
      amountIn: b.amountIn,
      amountOut: b.amountOut,
      slippage,
      mevProtected: b.mevProtected === true,
      feeCollected: b.feeCollected === true,
      // [P118] Quoted output: digits or nothing.
      expectedOutput: typeof b.expectedOutput === 'string' && AMOUNT_RE.test(b.expectedOutput) ? b.expectedOutput : null,
      // [P104 / 13A-L-02] Advisory, CoW rows only, clamped to [0, 500]. It stays on the PENDING row; a verified row
      // gets 0 (ADR-029: no caller value on a verified row).
      gasSavingsUsd:
        source === 'cowswap' && Number.isFinite(Number(b.bestNonCowGasUsd)) ? Math.max(0, Math.min(Number(b.bestNonCowGasUsd), 500)) : 0,
      txHash,
    },
  }
}

export interface ConfirmSwapInput {
  txHash: string
  /** null: the request named no wallet (the browser sends none when the wallet disconnected before the receipt). */
  wallet: string | null
}

export function parseConfirmSwap(body: unknown): Parsed<ConfirmSwapInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('txHash is required')
  const b = body as Record<string, unknown>
  if (!isPresent(b.txHash)) return bad('txHash is required')
  if (typeof b.txHash !== 'string' || !TX_HASH_RE.test(b.txHash)) return bad('Invalid txHash')
  if (!isPresent(b.wallet)) return { ok: true, value: { txHash: b.txHash.toLowerCase(), wallet: null } }
  if (typeof b.wallet !== 'string' || !ADDRESS_RE.test(b.wallet)) return bad('Invalid wallet')
  return { ok: true, value: { txHash: b.txHash.toLowerCase(), wallet: b.wallet.toLowerCase() } }
}
