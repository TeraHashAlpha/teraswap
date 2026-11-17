/**
 * [fix/orders-server-side-order-hash, audit 2026-11-16 S-5] Pure core of check-order-hashes.ts.
 *
 * For each `orders` row: rebuild the signed Order from `order_data` exactly as the keeper does before
 * it calls executeOrder (executor.js "Use order_data directly", v3 iff order_data.maxSlippageBps is
 * neither undefined nor null, executor-routing.js:25; routerDataHash || ZeroHash), hash it with the
 * server's computeOrderHash, and compare with the stored `order_hash` (lower case, one 0x).
 *
 * order_data is the struct that goes on-chain, so "computed" is the hash the executor will key this
 * order under. A row the keeper could not rebuild (no order_data, a missing/invalid field) is
 * `uncomputable`, never silently `match`.
 *
 * Read-only: no network, no database, no environment.
 */
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
import { computeOrderHash, normalizeOrderHashText } from '../../src/lib/order-engine/order-hash.ts'
// @ts-expect-error TS5097 - same
import { ORDER_EIP712_TYPES, ORDER_V3_EIP712_TYPES } from '../../src/lib/order-engine/order-eip712-types.ts'

const ZERO_HASH = `0x${'0'.repeat(64)}`

export type Verdict =
  | { id: unknown; chain_id: unknown; verdict: 'match'; stored: string; computed: string }
  | { id: unknown; chain_id: unknown; verdict: 'differs'; stored: unknown; computed: string; version: 2 | 3 }
  | { id: unknown; chain_id: unknown; verdict: 'uncomputable'; stored: unknown; reason: string }

/** The keeper's struct (executor.js orderStruct), as an EIP-712 message for the server function. */
export function messageFromOrderData(od: Record<string, unknown>): { version: 2 | 3; message: Record<string, unknown> } {
  const isV3 = od.maxSlippageBps !== undefined && od.maxSlippageBps !== null
  const big = (k: string) => {
    const v = od[k]
    if (v === undefined || v === null || v === '') throw new Error(`order_data.${k} missing`)
    return BigInt(v as string | number)
  }
  const num = (k: string) => {
    const v = Number(od[k])
    if (od[k] === undefined || od[k] === null || !Number.isInteger(v)) throw new Error(`order_data.${k} missing or not an integer`)
    return v
  }
  const address = (k: string) => {
    const v = od[k]
    if (typeof v !== 'string') throw new Error(`order_data.${k} missing`)
    return v
  }
  return {
    version: isV3 ? 3 : 2,
    message: {
      owner: address('owner'),
      tokenIn: address('tokenIn'),
      tokenOut: address('tokenOut'),
      amountIn: big('amountIn'),
      minAmountOut: big('minAmountOut'),
      ...(isV3 ? { maxSlippageBps: num('maxSlippageBps') } : {}),
      orderType: num('orderType'),
      condition: num('condition'),
      targetPrice: big('targetPrice'),
      priceFeed: address('priceFeed'),
      expiry: big('expiry'),
      nonce: big('nonce'),
      router: address('router'),
      routerDataHash: (od.routerDataHash as string) || ZERO_HASH,
      dcaInterval: big('dcaInterval'),
      dcaTotal: big('dcaTotal'),
    },
  }
}

export function checkRow(row: Record<string, unknown>): Verdict {
  const { id, chain_id } = row
  const stored = row.order_hash
  const od = row.order_data
  if (!od || typeof od !== 'object' || Array.isArray(od)) {
    return { id, chain_id, verdict: 'uncomputable', stored, reason: 'order_data missing (the keeper skips such a row)' }
  }
  let version: 2 | 3
  let computed: string
  try {
    const built = messageFromOrderData(od as Record<string, unknown>)
    version = built.version
    computed = computeOrderHash({ types: version === 3 ? ORDER_V3_EIP712_TYPES : ORDER_EIP712_TYPES, message: built.message })
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return { id, chain_id, verdict: 'uncomputable', stored, reason: msg.slice(0, 200) }
  }
  if (normalizeOrderHashText(stored) === computed) {
    return { id, chain_id, verdict: 'match', stored: stored as string, computed }
  }
  return { id, chain_id, verdict: 'differs', stored, computed, version }
}

export function checkRows(rows: unknown): Verdict[] {
  if (!Array.isArray(rows)) throw new Error('input must be a JSON array of orders rows')
  return rows.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return { id: `#${i}`, chain_id: null, verdict: 'uncomputable' as const, stored: null, reason: 'not an object' }
    }
    return checkRow(r as Record<string, unknown>)
  })
}
