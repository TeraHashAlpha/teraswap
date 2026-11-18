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
import { hashStruct, hashTypedData, type Hex, type TypedDataDomain } from 'viem'

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
