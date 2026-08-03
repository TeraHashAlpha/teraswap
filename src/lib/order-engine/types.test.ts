/**
 * [CHORE-EIP712-ORDER-TYPES-DEDUP] Lock the Order EIP-712 schema + typed-data
 * hash.
 *
 * ORDER_EIP712_TYPES is the SINGLE source of truth for the conditional-order
 * signature schema: the client signs with it (useOrderEngine) and the server
 * recovers with it (/api/orders). It was previously re-declared inline in
 * orders/route.ts — byte-identical at dedup time (proven: hashTypedData over a
 * fixed message produced the same digest from both declarations) — and any
 * one-sided edit would have silently broken signature recovery with a 400
 * "Signature mismatch". These tests make ANY schema change loud:
 *
 *  1. the exact 15-field schema (names, solidity types, ORDER — order changes
 *     the struct hash) is pinned with a readable diff;
 *  2. the typed-data digest of a fixed order under a fixed domain is pinned to
 *     a constant (env-independent — the domain is written out literally);
 *  3. a sign→recover roundtrip proves the exact call shape the route uses
 *     (recoverTypedDataAddress) accepts the canonical schema.
 *
 * If a field is added/renamed/reordered ON PURPOSE (contract upgrade), update
 * the pins here AND bump the EIP-712 domain/contract in the same change —
 * signatures produced under the old schema must not verify under the new one.
 */
import { describe, it, expect } from 'vitest'
import { hashTypedData, recoverTypedDataAddress, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ORDER_EIP712_TYPES, ORDER_V3_EIP712_TYPES, ORDER_V3_TYPE_STRING, MAX_ORDER_SLIPPAGE_BPS, DEFAULT_MAX_SLIPPAGE_BPS } from './types'
import { getOrderExecutorDomain } from './config'

/** Fixed domain — written literally so the pin cannot drift via env overrides. */
const PINNED_DOMAIN = {
  name: 'TeraSwapOrderExecutor',
  version: '2',
  chainId: 1,
  verifyingContract: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
} as const

/** Fixed order message covering all 15 fields with distinct, deterministic values. */
const PINNED_MESSAGE = {
  owner: '0x1111111111111111111111111111111111111111',
  // Public mainnet token addresses (WETH/USDC) — not secrets; the field names
  // ('token…') trip gitleaks' generic-api-key keyword heuristic.
  tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // gitleaks:allow
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // gitleaks:allow
  amountIn: 1000000000000000000n,
  minAmountOut: 1700000000n,
  orderType: 0,
  condition: 0,
  targetPrice: 200000000000n,
  priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  expiry: 1790000000n,
  nonce: 7n,
  router: '0x111111125421cA6dc452d289314280a0f8842A65',
  routerDataHash: `0x${'ab'.repeat(32)}`,
  dcaInterval: 0n,
  dcaTotal: 1n,
} as const

/** Digest computed from the canonical schema at dedup time (2026-07-06) —
 *  identical to the digest the (now removed) orders/route.ts duplicate
 *  produced over the same message, proving the dedup changed nothing. */
const PINNED_DIGEST = '0x16163a1502cf4585354aa7248b1550a5755f2da646d8a42c7dcc59f5a8097070'

describe('ORDER_EIP712_TYPES — single-source schema lock [CHORE-EIP712-ORDER-TYPES-DEDUP]', () => {
  it('pins the exact 15-field schema (names, types, ORDER)', () => {
    expect(ORDER_EIP712_TYPES.Order).toEqual([
      { name: 'owner', type: 'address' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'orderType', type: 'uint8' },
      { name: 'condition', type: 'uint8' },
      { name: 'targetPrice', type: 'uint256' },
      { name: 'priceFeed', type: 'address' },
      { name: 'expiry', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'router', type: 'address' },
      { name: 'routerDataHash', type: 'bytes32' },
      { name: 'dcaInterval', type: 'uint256' },
      { name: 'dcaTotal', type: 'uint256' },
    ])
  })

  it('pins the typed-data digest of a fixed order (any schema/domain change breaks this loudly)', () => {
    const digest = hashTypedData({
      domain: PINNED_DOMAIN,
      types: ORDER_EIP712_TYPES,
      primaryType: 'Order',
      message: PINNED_MESSAGE,
    })
    expect(digest).toBe(PINNED_DIGEST)
  })

  it('sign→recover roundtrip works with the canonical schema (the exact route call shape)', async () => {
    // Throwaway key — never funded, never reused anywhere.
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
    const domain = getOrderExecutorDomain(1)
    const message = { ...PINNED_MESSAGE, owner: account.address }
    const signature = await account.signTypedData({
      domain,
      types: ORDER_EIP712_TYPES,
      primaryType: 'Order',
      message,
    })
    const recovered = await recoverTypedDataAddress({
      domain,
      types: ORDER_EIP712_TYPES,
      primaryType: 'Order',
      message,
      signature,
    })
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })
})

// ── [SPRINT-V3-P2 / ADR-013 §1] v3 schema — struct/ABI parity with the audited contract ────
// The contract is FROZEN + audit-approved (SHA 954c415). These pins make ANY future drift
// between the TS schema here and contracts/order-engine/TeraSwapOrderExecutorV3.sol's
// ORDER_TYPEHASH loud — a mismatch would make recoverTypedDataAddress disagree with the
// contract's on-chain signer recovery (escalate as a P1 finding per the sprint spec).
describe('ORDER_V3_EIP712_TYPES — v3 schema lock [ADR-013 §1]', () => {
  // Verbatim copy of TeraSwapOrderExecutorV3.sol:120-125 ORDER_TYPEHASH source string.
  const CONTRACT_TYPE_STRING =
    'Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,' +
    'uint256 minAmountOut,uint16 maxSlippageBps,uint8 orderType,uint8 condition,' +
    'uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,' +
    'bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)'

  it('ORDER_V3_TYPE_STRING matches the .sol ORDER_TYPEHASH source byte-for-byte', () => {
    expect(ORDER_V3_TYPE_STRING).toBe(CONTRACT_TYPE_STRING)
  })

  it('the 16-field v3 schema is v2 + maxSlippageBps(uint16) inserted right after minAmountOut', () => {
    expect(ORDER_V3_EIP712_TYPES.Order).toEqual([
      { name: 'owner', type: 'address' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'maxSlippageBps', type: 'uint16' },
      { name: 'orderType', type: 'uint8' },
      { name: 'condition', type: 'uint8' },
      { name: 'targetPrice', type: 'uint256' },
      { name: 'priceFeed', type: 'address' },
      { name: 'expiry', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'router', type: 'address' },
      { name: 'routerDataHash', type: 'bytes32' },
      { name: 'dcaInterval', type: 'uint256' },
      { name: 'dcaTotal', type: 'uint256' },
    ])
  })

  it('the TS type-array reconstructs to the exact pinned type string (structural, not just eyeballed)', () => {
    const reconstructed = `Order(${ORDER_V3_EIP712_TYPES.Order.map(f => `${f.type} ${f.name}`).join(',')})`
    expect(reconstructed).toBe(ORDER_V3_TYPE_STRING)
  })

  it('ORDER_TYPEHASH (keccak256 of the type string) is a deterministic, non-empty hash', () => {
    // Not compared against a live contract read (no RPC in unit tests) — this pins that our
    // string produces a stable typehash, and the byte-for-byte string pin above is what proves
    // parity with the .sol source.
    const typehash = keccak256(toBytes(ORDER_V3_TYPE_STRING))
    expect(typehash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('v3 sign→recover roundtrip works with maxSlippageBps included', async () => {
    const account = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const domain = {
      name: 'TeraSwapOrderExecutor' as const,
      version: '3' as const,
      chainId: 1,
      verifyingContract: '0x2222222222222222222222222222222222222222' as const,
    }
    const message = { ...PINNED_MESSAGE, owner: account.address, maxSlippageBps: 300 }
    const signature = await account.signTypedData({
      domain, types: ORDER_V3_EIP712_TYPES, primaryType: 'Order', message,
    })
    const recovered = await recoverTypedDataAddress({
      domain, types: ORDER_V3_EIP712_TYPES, primaryType: 'Order', message, signature,
    })
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('a v2 signature over the SAME message content does not recover under the v3 schema+domain', async () => {
    // Proves the two schemas are cryptographically distinct — a v2 signature can never be
    // replayed as a valid v3 order (different typehash AND different domain version).
    const account = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const v2Domain = { ...PINNED_DOMAIN, verifyingContract: '0x2222222222222222222222222222222222222222' as const }
    const v2Message = { ...PINNED_MESSAGE, owner: account.address }
    const v2Signature = await account.signTypedData({
      domain: v2Domain, types: ORDER_EIP712_TYPES, primaryType: 'Order', message: v2Message,
    })

    const v3Domain = { name: 'TeraSwapOrderExecutor' as const, version: '3' as const, chainId: 1, verifyingContract: v2Domain.verifyingContract }
    const v3Message = { ...v2Message, maxSlippageBps: 300 }
    const recovered = await recoverTypedDataAddress({
      domain: v3Domain, types: ORDER_V3_EIP712_TYPES, primaryType: 'Order', message: v3Message, signature: v2Signature,
    })
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase())
  })

  it('MAX_ORDER_SLIPPAGE_BPS mirrors the immutable contract constant (500)', () => {
    expect(MAX_ORDER_SLIPPAGE_BPS).toBe(500)
  })

  it('DEFAULT_MAX_SLIPPAGE_BPS (300) is within the contract cap', () => {
    expect(DEFAULT_MAX_SLIPPAGE_BPS).toBeGreaterThan(0)
    expect(DEFAULT_MAX_SLIPPAGE_BPS).toBeLessThanOrEqual(MAX_ORDER_SLIPPAGE_BPS)
  })
})
