/**
 * [fix/orders-server-side-order-hash, audit 2026-11-16 S-5] The ONE server-side order hash.
 *
 * POST /api/orders used to store `order_hash: body.orderHash` exactly as the caller sent it, so one
 * signed order could be stored twice under two texts, and a row's order_hash need not be the hash of
 * the order it holds. The route now stores computeOrderHash() of the typed data it has just recovered
 * the signer from; scripts/orders/check-order-hashes.ts uses the same function on stored rows.
 *
 * What "the order hash" is (read from the contracts, not assumed):
 *   - OrderExecutorV3.getOrderHash(order) (TeraSwapOrderExecutorV3.sol:1149) is
 *     keccak256(abi.encode(ORDER_TYPEHASH, ...the 16 signed fields)): the EIP-712 *struct hash*.
 *     It keys cancelledOrders / dcaExecutions / dcaLastExecution and is the OrderExecuted /
 *     OrderCancelled topic. The v2 executor's getOrderHash (TeraSwapOrderExecutor.sol:964) is the
 *     same construction over the 15 v2 fields.
 *   - The domain (name, version, chainId, verifyingContract) does NOT enter that hash. It enters only
 *     the digest the signature is checked against: ECDSA.recover(_hashTypedDataV4(orderHash), sig)
 *     (V3 :360, :449) = keccak256(0x1901 ‖ domainSeparator ‖ orderHash) = computeOrderDigest().
 *   - The client already sends this struct hash (useOrderEngine.ts computeOrderHash), the schema
 *     calls the column the "EIP-712 struct hash" (schema.sql order_hash), and the keeper's backfill
 *     looks rows up by the OrderExecuted topic (backfill-execution.mjs:169).
 *
 * Both functions take the SAME `types` object the route passes to recoverTypedDataAddress, so the
 * stored hash and the recovered signer are computed over one encoding of one message. The Foundry
 * differential (contracts/order-engine/test/OrderHashDifferential.t.sol) checks computeOrderHash
 * against the contracts' own getOrderHash and computeOrderDigest against their domainSeparator().
 *
 * No local imports on purpose: plain-Node scripts load this file through type stripping.
 */
import { hashStruct, hashTypedData, keccak256, toBytes, type Hex, type TypedDataDomain } from 'viem'

/** An EIP-712 schema with an `Order` primary type (ORDER_EIP712_TYPES or ORDER_V3_EIP712_TYPES). */
export type OrderTypes = {
  readonly Order: readonly { readonly name: string; readonly type: string }[]
}

export interface OrderTypedData {
  domain: TypedDataDomain
  types: OrderTypes
  /** The signed fields, exactly as passed to recoverTypedDataAddress. */
  message: Record<string, unknown>
}

/**
 * The order hash the contracts use: EIP-712 hashStruct("Order", message) under `types`.
 * Throws (viem) when a field is missing or out of range for its type, exactly where recovery would.
 */
export function computeOrderHash(typedData: Pick<OrderTypedData, 'types' | 'message'>): Hex {
  return hashStruct({
    data: typedData.message,
    primaryType: 'Order',
    types: typedData.types as unknown as Parameters<typeof hashStruct>[0]['types'],
  })
}

/** The digest the order signature is checked against under `domain` (= the contract's _hashTypedDataV4). */
export function computeOrderDigest(typedData: OrderTypedData): Hex {
  return hashTypedData({
    domain: typedData.domain,
    types: typedData.types as unknown as Parameters<typeof hashTypedData>[0]['types'],
    primaryType: 'Order',
    message: typedData.message,
  } as Parameters<typeof hashTypedData>[0])
}

/**
 * A caller's orderHash text normalised for COMPARISON only: lower case, exactly one leading 0x.
 * null when the value is not a string. Never stored.
 */
export function normalizeOrderHashText(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const lower = text.toLowerCase()
  return lower.startsWith('0x') ? lower : `0x${lower}`
}

const HASH_SHAPE_RE = /^(?:0[xX])?[0-9a-fA-F]{64}$/

/**
 * [A95 S-1] How a caller-supplied (or stored, caller-written) text may appear in a log or a report: its SHAPE only,
 * never the text. `<hash-shaped>` (0x/0X/no prefix + 64 hex), `<string len N>` for any other string, `<type T>` for
 * anything that is not a string. A text that mixes hex of a signature with other hex has the shape of a hash, so a
 * shape is all a log may carry: no rule about which hex is "a fragment of the signature" can be complete.
 */
export function describeCallerText(value: unknown): string {
  if (typeof value !== 'string') return `<type ${typeof value}>`
  return HASH_SHAPE_RE.test(value) ? '<hash-shaped>' : `<string len ${value.length}>`
}

/**
 * [A95 S-1] The first 16 hex of keccak256(utf-8 text): lets two log lines about the same text be matched without the text.
 * null when the value is not a string.
 */
export function callerTextDigest(value: unknown): string | null {
  return typeof value === 'string' ? keccak256(toBytes(value)).slice(2, 18) : null
}

/** The order of the secp256k1 group. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const SIGNATURE_TEXT_RE = /^(?:0[xX])?[0-9a-fA-F]{130}$/

/**
 * [A86 S-3] Every text of one 65-byte signature (r ‖ s ‖ v) that viem's recovery accepts for the same signer, lower
 * case with 0x: v as 27/28 and as 0/1, for s and for its twin n − s with the other parity. viem accepts all four
 * (recoverPublicKey: v ∈ {0, 1, 27, 28}, any s in [1, n−1]); the executors' OZ ECDSA.recover accepts only the low-s
 * one with v 27/28 (= canonicalOrderSignature). The first entry is the given text, lower-cased.
 * null when the text is not (0x +) 130 hex, v is not 0/1/27/28, or s is not in [1, n−1].
 */
export function orderSignatureEncodings(signature: unknown): string[] | null {
  if (typeof signature !== 'string' || !SIGNATURE_TEXT_RE.test(signature)) return null
  const hex = signature.slice(signature.length - 130).toLowerCase()
  const r = hex.slice(0, 64)
  const sHex = hex.slice(64, 128)
  const v = parseInt(hex.slice(128), 16)
  const s = BigInt(`0x${sHex}`)
  if (s === 0n || s >= SECP256K1_N) return null
  const parity = v === 0 || v === 27 ? 0 : v === 1 || v === 28 ? 1 : null
  if (parity === null) return null
  const twinHex = (SECP256K1_N - s).toString(16).padStart(64, '0')
  const vTexts = (p: number) => [(27 + p).toString(16), `0${p}`] // '1b' | '1c', '00' | '01'
  const own = vTexts(parity).map((vt) => `0x${r}${sHex}${vt}`)
  const twin = vTexts(1 - parity).map((vt) => `0x${r}${twinHex}${vt}`)
  const given = `0x${hex}`
  return [given, ...[...own, ...twin].filter((t) => t !== given)]
}

/**
 * [A86 S-3] The one text the executors accept for this signature: low s (s ≤ n/2), v 27/28, lower case with 0x.
 * Two rows whose signatures have the same canonical text hold the same signature. null as orderSignatureEncodings.
 */
export function canonicalOrderSignature(signature: unknown): string | null {
  const all = orderSignatureEncodings(signature)
  if (!all) return null
  return all.find((t) => (t.endsWith('1b') || t.endsWith('1c')) && BigInt(`0x${t.slice(66, 130)}`) <= SECP256K1_N / 2n) ?? null
}
