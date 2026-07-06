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
import { hashTypedData, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ORDER_EIP712_TYPES } from './types'
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
