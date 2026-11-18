// @vitest-environment node
/**
 * [fix/orders-server-side-order-hash] Unit pins for order-hash.ts. The equality with the contracts is
 * proven by the Foundry differential (contracts/order-engine/test/OrderHashDifferential.t.sol, fed by
 * scripts/orders/order-hash-vectors.ts); this file pins the function's own contract.
 */
import { describe, it, expect } from 'vitest'
import { keccak256, recoverTypedDataAddress, toBytes, zeroHash, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  computeOrderHash, computeOrderDigest, normalizeOrderHashText, orderSignatureEncodings, canonicalOrderSignature,
} from './order-hash'
import { ORDER_EIP712_TYPES, ORDER_V3_EIP712_TYPES } from './types'

const MESSAGE = {
  owner: '0x1111111111111111111111111111111111111111',
  tokenIn: '0x2222222222222222222222222222222222222222',
  tokenOut: '0x3333333333333333333333333333333333333333',
  amountIn: '1000000000000000000',
  minAmountOut: '100',
  maxSlippageBps: 300,
  orderType: 2,
  condition: 0,
  targetPrice: '0',
  priceFeed: '0x0000000000000000000000000000000000000000',
  expiry: 1_800_000_000,
  nonce: 7,
  router: '0x4444444444444444444444444444444444444444',
  routerDataHash: zeroHash,
  dcaInterval: 3600,
  dcaTotal: 3,
}
const DOMAIN = { name: 'TeraSwapOrderExecutor', version: '3', chainId: 8453, verifyingContract: '0x686b4f812291F4De238E59ED00BA6dD6129e60a0' } as const

describe('computeOrderHash', () => {
  it('is a 32-byte lower-case hex string', () => {
    expect(computeOrderHash({ types: ORDER_V3_EIP712_TYPES, message: MESSAGE })).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('does not depend on the domain (struct hash); the digest does', () => {
    const h = computeOrderHash({ types: ORDER_V3_EIP712_TYPES, message: MESSAGE })
    const arbitrum = { ...DOMAIN, chainId: 42161, verifyingContract: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459' } as const
    expect(computeOrderDigest({ domain: DOMAIN, types: ORDER_V3_EIP712_TYPES, message: MESSAGE }))
      .not.toBe(computeOrderDigest({ domain: arbitrum, types: ORDER_V3_EIP712_TYPES, message: MESSAGE }))
    expect(computeOrderHash({ types: ORDER_V3_EIP712_TYPES, message: MESSAGE })).toBe(h)
  })

  it('every signed field changes the hash', () => {
    const base = computeOrderHash({ types: ORDER_V3_EIP712_TYPES, message: MESSAGE })
    const bumped: Record<string, unknown> = {
      owner: '0x5555555555555555555555555555555555555555', tokenIn: '0x5555555555555555555555555555555555555555',
      tokenOut: '0x5555555555555555555555555555555555555555', amountIn: '1000000000000000001', minAmountOut: '101',
      maxSlippageBps: 301, orderType: 0, condition: 1, targetPrice: '1',
      priceFeed: '0x5555555555555555555555555555555555555555', expiry: 1_800_000_001, nonce: 8,
      router: '0x5555555555555555555555555555555555555555', routerDataHash: `0x${'01'.repeat(32)}`,
      dcaInterval: 3601, dcaTotal: 4,
    }
    expect(Object.keys(bumped).sort()).toEqual(ORDER_V3_EIP712_TYPES.Order.map((f) => f.name).sort())
    for (const [k, v] of Object.entries(bumped)) {
      expect(computeOrderHash({ types: ORDER_V3_EIP712_TYPES, message: { ...MESSAGE, [k]: v } }), k).not.toBe(base)
    }
  })

  it('v2 and v3 schemas give different hashes for the same shared fields', () => {
    const { maxSlippageBps: _drop, ...v2 } = MESSAGE
    expect(computeOrderHash({ types: ORDER_EIP712_TYPES, message: v2 }))
      .not.toBe(computeOrderHash({ types: ORDER_V3_EIP712_TYPES, message: MESSAGE }))
  })

  it('throws on a missing signed field instead of hashing a different order', () => {
    const { dcaTotal: _drop, ...partial } = MESSAGE
    expect(() => computeOrderHash({ types: ORDER_V3_EIP712_TYPES, message: partial })).toThrow()
  })

  it('throws on an out-of-range value (uint16 maxSlippageBps)', () => {
    expect(() => computeOrderHash({ types: ORDER_V3_EIP712_TYPES, message: { ...MESSAGE, maxSlippageBps: 70_000 } })).toThrow()
  })
})

describe('normalizeOrderHashText', () => {
  const h = `0x${'ab'.repeat(32)}`
  it.each([
    [h, h],
    [h.toUpperCase(), h],                 // 0X + upper-case hex
    [`0x${'AB'.repeat(32)}`, h],
    [h.slice(2), h],                      // no prefix
    ['', '0x'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeOrderHashText(input)).toBe(expected)
  })
  it.each([[undefined], [null], [42], [{ h }]])('non-string %s → null', (input) => {
    expect(normalizeOrderHashText(input)).toBeNull()
  })
})

// [A86 S-3] The texts of one signature that recover the same signer.
describe('orderSignatureEncodings / canonicalOrderSignature', () => {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  const account = privateKeyToAccount(keccak256(toBytes('order-hash signature encodings')))
  const sign = () => account.signTypedData({ domain: DOMAIN, types: ORDER_V3_EIP712_TYPES, primaryType: 'Order', message: MESSAGE as never })
  const recover = (signature: string) => recoverTypedDataAddress({
    domain: DOMAIN, types: ORDER_V3_EIP712_TYPES, primaryType: 'Order', message: MESSAGE as never, signature: signature as Hex,
  })
  const parts = (t: string) => ({ s: BigInt(`0x${t.slice(66, 130)}`), v: t.slice(130) })

  it('gives 4 distinct lower-case texts, the given one first, and every one recovers the same signer (real recovery)', async () => {
    const sig = await sign()
    const all = orderSignatureEncodings(sig)!
    expect(all).toHaveLength(4)
    expect(new Set(all).size).toBe(4)
    expect(all[0]).toBe(sig.toLowerCase())
    for (const t of all) {
      expect(t).toMatch(/^0x[0-9a-f]{130}$/)
      expect(await recover(t)).toBe(account.address)
    }
    expect(all.map((t) => parts(t).v).sort()).toEqual(['00', '01', '1b', '1c'])
    const ss = [...new Set(all.map((t) => parts(t).s))]
    expect(ss).toHaveLength(2)
    expect(ss[0] + ss[1]).toBe(N)
  })

  it('every encoding (and upper case, 0X, no prefix) gives the same set and the same canonical text', async () => {
    const sig = await sign()
    const all = orderSignatureEncodings(sig)!
    const canonical = canonicalOrderSignature(sig)!
    expect(parts(canonical).s <= N / 2n).toBe(true)
    expect(['1b', '1c']).toContain(parts(canonical).v)
    for (const t of [...all, sig.toUpperCase(), `0x${sig.slice(2).toUpperCase()}`, sig.slice(2)]) {
      expect(new Set(orderSignatureEncodings(t))).toEqual(new Set(all))
      expect(canonicalOrderSignature(t)).toBe(canonical)
    }
  })

  it.each([
    ['not a string', 42],
    ['too short', `0x${'11'.repeat(64)}`],
    ['a pattern character', `0x${'11'.repeat(64)}%b`],
    ['v = 2', `0x${'11'.repeat(64)}02`],
    ['v = 29', `0x${'11'.repeat(64)}1d`],
    ['s = 0', `0x${'11'.repeat(32)}${'00'.repeat(32)}1b`],
    ['s = n', `0x${'11'.repeat(32)}${N.toString(16)}1b`],
  ])('%s → null', (_label, input) => {
    expect(orderSignatureEncodings(input)).toBeNull()
    expect(canonicalOrderSignature(input)).toBeNull()
  })
})
