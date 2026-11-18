/**
 * [fix/orders-server-side-order-hash, audit 2026-11-16 S-5] Pure core of check-order-hashes.ts.
 *
 * For each `orders` row: rebuild the signed Order from `order_data` exactly as the keeper does before
 * it calls executeOrder (executor.js "Use order_data directly", v3 iff order_data.maxSlippageBps is
 * neither undefined nor null, executor-routing.js:25; routerDataHash || ZeroHash), hash it with the
 * server's computeOrderHash, and compare with the stored `order_hash`.
 *
 * order_data is the struct that goes on-chain, so "computed" is the hash the executor will key this
 * order under. A row the keeper could not rebuild (no order_data, a missing/invalid field) is
 * `uncomputable`, never silently `match`.
 *
 * [A86 S-2] `match` means the stored text is BYTE-equal to the computed hash, because UNIQUE(order_hash) compares
 * bytes: a row stored as 0x + upper case, 0X, or without 0x names the right order but does not stop a second row, so
 * it is `non-canonical`. groupRows() reports the rows that hold one order more than once: by computed hash, and by
 * signature (one signature in any of the 4 texts viem recovers the same signer from, canonicalOrderSignature).
 * [A86 S-8] Addresses are lower-cased before hashing: the keeper's getAddress accepts a mixed-case address whose
 * checksum is wrong, so the hash must not refuse it.
 *
 * Nothing this module returns carries a signature: field errors name the field, never its value, and stored texts
 * pass through safeText() before they are reported.
 *
 * Read-only: no network, no database, no environment.
 */
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
import { computeOrderHash, canonicalOrderSignature, orderSignatureEncodings } from '../../src/lib/order-engine/order-hash.ts'
// @ts-expect-error TS5097 - same
import { ORDER_EIP712_TYPES, ORDER_V3_EIP712_TYPES } from '../../src/lib/order-engine/order-eip712-types.ts'

const ZERO_HASH = `0x${'0'.repeat(64)}`
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const UINT256_MAX = (1n << 256n) - 1n
const HASH_SHAPE_RE = /^(?:0[xX])?[0-9a-fA-F]{64}$/
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export type Verdict =
  | { id: unknown; chain_id: unknown; verdict: 'match'; stored: string; computed: string }
  | { id: unknown; chain_id: unknown; verdict: 'non-canonical'; stored: string; computed: string }
  | { id: unknown; chain_id: unknown; verdict: 'differs'; stored: unknown; computed: string; version: 2 | 3 }
  | { id: unknown; chain_id: unknown; verdict: 'uncomputable'; stored: unknown; reason: string }

export interface Groups {
  /** Two or more rows whose order_data hashes to the same order. */
  sameComputedHash: { computed: string; ids: unknown[] }[]
  /** Two or more rows holding one signature (in any of its texts). */
  sameSignature: { ids: unknown[] }[]
  /** Rows with no signature text, so they could not be grouped by signature. */
  withoutSignature: unknown[]
}

/**
 * A stored order_hash text as it may be printed: a hash-shaped or UUID-shaped text as is, any other string as
 * `<string len N>` (a pre-#708 row may hold a caller's arbitrary text, a signature included), null as null, another
 * type by its type.
 * [A89 R2-2] A hash-shaped text that is a window of the row's OWN signature (r, s or any 64 hex of it, in any of the 4
 * texts that recover the same signer) is printed as `<signature fragment len N>`: such a text has the shape of a hash.
 */
export function safeText(value: unknown, signature?: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return `<${typeof value}>`
  if (HASH_SHAPE_RE.test(value) && isSignatureFragment(value, signature)) return `<signature fragment len ${value.length}>`
  return HASH_SHAPE_RE.test(value) || UUID_RE.test(value) ? value : `<string len ${value.length}>`
}

/** [A89 R2-2] Whether `text` (0x/0X/no prefix, any case) occurs inside `signature` in one of its recoverable texts. */
function isSignatureFragment(text: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || signature === '') return false
  const hex = text.replace(/^0[xX]/, '').toLowerCase()
  const texts = orderSignatureEncodings(signature) ?? [signature.toLowerCase()]
  return texts.some((sig) => sig.replace(/^0[xX]/, '').includes(hex))
}

/** The keeper's struct (executor.js orderStruct), as an EIP-712 message for the server function. */
export function messageFromOrderData(od: Record<string, unknown>): { version: 2 | 3; message: Record<string, unknown> } {
  const isV3 = od.maxSlippageBps !== undefined && od.maxSlippageBps !== null
  const big = (k: string) => {
    const v = od[k]
    if (v === undefined || v === null || v === '') throw new Error(`order_data.${k} missing`)
    let n: bigint
    try {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint') throw new Error()
      n = BigInt(v)
    } catch {
      throw new Error(`order_data.${k} is not an integer`)
    }
    if (n < 0n || n > UINT256_MAX) throw new Error(`order_data.${k} is out of uint256 range`)
    return n
  }
  const num = (k: string, max: number) => {
    const v = Number(od[k])
    if (od[k] === undefined || od[k] === null || !Number.isInteger(v)) throw new Error(`order_data.${k} missing or not an integer`)
    if (v < 0 || v > max) throw new Error(`order_data.${k} is out of range`)
    return v
  }
  // [A86 S-8] Any case, lower-cased: viem refuses a mixed-case address with a wrong checksum, the keeper does not.
  const address = (k: string) => {
    const v = od[k]
    if (typeof v !== 'string') throw new Error(`order_data.${k} missing`)
    if (!ADDRESS_RE.test(v)) throw new Error(`order_data.${k} is not an address`)
    return v.toLowerCase()
  }
  const routerDataHash = (() => {
    const v = od.routerDataHash
    if (!v) return ZERO_HASH
    if (typeof v !== 'string' || !BYTES32_RE.test(v)) throw new Error('order_data.routerDataHash is not bytes32')
    return v.toLowerCase()
  })()
  return {
    version: isV3 ? 3 : 2,
    message: {
      owner: address('owner'),
      tokenIn: address('tokenIn'),
      tokenOut: address('tokenOut'),
      amountIn: big('amountIn'),
      minAmountOut: big('minAmountOut'),
      ...(isV3 ? { maxSlippageBps: num('maxSlippageBps', 0xffff) } : {}),
      orderType: num('orderType', 0xff),
      condition: num('condition', 0xff),
      targetPrice: big('targetPrice'),
      priceFeed: address('priceFeed'),
      expiry: big('expiry'),
      nonce: big('nonce'),
      router: address('router'),
      routerDataHash,
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
    // Our own messages name the field only; anything else is reported by its error name, never its text (a viem
    // message quotes the value it refused).
    const msg = err instanceof Error && err.message.startsWith('order_data.')
      ? err.message
      : `hash failed (${err instanceof Error ? err.name : typeof err})`
    return { id, chain_id, verdict: 'uncomputable', stored, reason: msg.slice(0, 200) }
  }
  if (stored === computed) return { id, chain_id, verdict: 'match', stored: stored as string, computed }
  if (typeof stored === 'string' && HASH_SHAPE_RE.test(stored) && `0x${stored.slice(-64).toLowerCase()}` === computed) {
    return { id, chain_id, verdict: 'non-canonical', stored, computed }
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

/** [A86 S-2] Rows that hold one order more than once. `verdicts` is checkRows(rows), in the same order. */
export function groupRows(rows: unknown[], verdicts: Verdict[]): Groups {
  const byComputed = new Map<string, unknown[]>()
  const bySignature = new Map<string, unknown[]>()
  const withoutSignature: unknown[] = []
  verdicts.forEach((v, i) => {
    if (v.verdict !== 'uncomputable') byComputed.set(v.computed, [...(byComputed.get(v.computed) ?? []), v.id])
    const row = rows[i] as Record<string, unknown> | null
    const sig = row && typeof row === 'object' ? row.signature : undefined
    if (typeof sig !== 'string' || sig === '') {
      withoutSignature.push(v.id)
      return
    }
    // The grouping key is never reported: only the ids are.
    const key = canonicalOrderSignature(sig) ?? `text:${sig.toLowerCase()}`
    bySignature.set(key, [...(bySignature.get(key) ?? []), v.id])
  })
  return {
    sameComputedHash: [...byComputed].filter(([, ids]) => ids.length > 1).map(([computed, ids]) => ({ computed, ids })),
    sameSignature: [...bySignature.values()].filter((ids) => ids.length > 1).map((ids) => ({ ids })),
    withoutSignature,
  }
}
