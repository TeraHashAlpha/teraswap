/**
 * Unit tests for src/lib/calldata-decoder.ts — transaction preview decoder.
 *
 * Tests cover: V3 exactInputSingle, V3 exactInput, 1inch swap, 1inch unoswapTo,
 * V2 swaps, multicall, msg.sender selectors, trusted router selectors,
 * unknown selector fallback, empty calldata, and SELECTOR_INFO completeness.
 */

import { describe, it, expect } from 'vitest'
import { encodeAbiParameters } from 'viem'
import { decodeTransactionPreview, SELECTOR_INFO } from './calldata-decoder'
import { VALIDATED_SELECTORS } from './calldata-recipient'

// ── Test helpers ───────────────────────────────────────

const ROUTER = '0x1111111254EEB25477B68fb85Ed929f73A960582' // 1inch v5 router (checksummed)
const USER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'     // vitalik.eth (checksummed)
const TOKEN_A = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'  // WETH
const TOKEN_B = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'  // USDC

/** Build calldata: selector + encoded params */
function buildCalldata(selector: string, encoded: string): string {
  return selector + encoded.slice(2) // encoded has leading 0x
}

// ═══════════════════════════════════════════════════════

describe('decodeTransactionPreview', () => {

  // ── V3 exactInputSingle ─────────────────────────────

  describe('V3 exactInputSingle (0x04e45aaf)', () => {
    const encoded = encodeAbiParameters(
      [{
        name: 'params', type: 'tuple', components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      }],
      [{
        tokenIn: TOKEN_A, tokenOut: TOKEN_B, fee: 3000,
        recipient: USER, amountIn: 1000000000000000000n,
        amountOutMinimum: 2900000000n, sqrtPriceLimitX96: 0n,
      }],
    )
    const calldata = buildCalldata('0x04e45aaf', encoded)

    it('decodes all fields', () => {
      const preview = decodeTransactionPreview(calldata, ROUTER, 'uniswap')
      expect(preview.sourceDex).toBe('Uniswap V3')
      expect(preview.functionName).toBe('exactInputSingle')
      expect(preview.selector).toBe('0x04e45aaf')
      expect(preview.validated).toBe(true)
      expect(preview.tokenIn?.toLowerCase()).toBe(TOKEN_A.toLowerCase())
      expect(preview.tokenOut?.toLowerCase()).toBe(TOKEN_B.toLowerCase())
      expect(preview.amountIn).toBe('1000000000000000000')
      expect(preview.amountOutMin).toBe('2900000000')
      expect(preview.recipient?.toLowerCase()).toBe(USER.toLowerCase())
      expect(preview.recipientType).toBe('extracted')
    })
  })

  // ── V3 exactInput ──────────────────────────────────

  describe('V3 exactInput (0xb858183f)', () => {
    // V3 multi-hop path: tokenA + fee + tokenB (packed bytes)
    const pathHex = TOKEN_A.toLowerCase().slice(2) + '000bb8' + TOKEN_B.toLowerCase().slice(2)
    const pathBytes = ('0x' + pathHex) as `0x${string}`

    const encoded = encodeAbiParameters(
      [{
        name: 'params', type: 'tuple', components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      }],
      [{
        path: pathBytes, recipient: USER,
        amountIn: 500000000000000000n, amountOutMinimum: 1400000000n,
      }],
    )
    const calldata = buildCalldata('0xb858183f', encoded)

    it('decodes path tokens and amounts', () => {
      const preview = decodeTransactionPreview(calldata, ROUTER, 'uniswap')
      expect(preview.functionName).toBe('exactInput')
      expect(preview.validated).toBe(true)
      expect(preview.amountIn).toBe('500000000000000000')
      expect(preview.amountOutMin).toBe('1400000000')
      expect(preview.recipient?.toLowerCase()).toBe(USER.toLowerCase())
    })
  })

  // ── 1inch swap ─────────────────────────────────────

  describe('1inch swap (0x12aa3caf)', () => {
    const encoded = encodeAbiParameters(
      [
        { name: 'executor', type: 'address' },
        {
          name: 'desc', type: 'tuple', components: [
            { name: 'srcToken', type: 'address' },
            { name: 'dstToken', type: 'address' },
            { name: 'srcReceiver', type: 'address' },
            { name: 'dstReceiver', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'minReturnAmount', type: 'uint256' },
            { name: 'flags', type: 'uint256' },
          ],
        },
        { name: 'permit', type: 'bytes' },
        { name: 'data', type: 'bytes' },
      ],
      [
        ROUTER,
        {
          srcToken: TOKEN_A, dstToken: TOKEN_B,
          srcReceiver: ROUTER, dstReceiver: USER,
          amount: 2000000000000000000n, minReturnAmount: 5800000000n,
          flags: 0n,
        },
        '0x', '0x',
      ],
    )
    const calldata = buildCalldata('0x12aa3caf', encoded)

    it('decodes desc tuple fields', () => {
      const preview = decodeTransactionPreview(calldata, ROUTER, '1inch')
      expect(preview.sourceDex).toBe('1inch')
      expect(preview.functionName).toBe('swap')
      expect(preview.tokenIn?.toLowerCase()).toBe(TOKEN_A.toLowerCase())
      expect(preview.tokenOut?.toLowerCase()).toBe(TOKEN_B.toLowerCase())
      expect(preview.amountIn).toBe('2000000000000000000')
      expect(preview.amountOutMin).toBe('5800000000')
      expect(preview.recipient?.toLowerCase()).toBe(USER.toLowerCase())
      expect(preview.recipientType).toBe('extracted')
      expect(preview.validated).toBe(true)
    })
  })

  // ── 1inch unoswapTo ────────────────────────────────

  describe('1inch unoswapTo (0x2e95b6c8)', () => {
    const encoded = encodeAbiParameters(
      [
        { name: 'recipient', type: 'address' },
        { name: 'srcToken', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'minReturn', type: 'uint256' },
        { name: 'pools', type: 'uint256[]' },
      ],
      [USER, TOKEN_A, 1000000000000000000n, 2800000000n, [0n]],
    )
    const calldata = buildCalldata('0x2e95b6c8', encoded)

    it('decodes recipient and amounts', () => {
      const preview = decodeTransactionPreview(calldata, ROUTER, '1inch')
      expect(preview.functionName).toBe('unoswapTo')
      expect(preview.tokenIn?.toLowerCase()).toBe(TOKEN_A.toLowerCase())
      expect(preview.amountIn).toBe('1000000000000000000')
      expect(preview.amountOutMin).toBe('2800000000')
      expect(preview.recipient?.toLowerCase()).toBe(USER.toLowerCase())
    })
  })

  // ── V2 swap ────────────────────────────────────────

  describe('V2 swapExactTokensForTokens with deadline (0x38ed1739)', () => {
    const deadline = Math.floor(Date.now() / 1000) + 1200
    const encoded = encodeAbiParameters(
      [
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMin', type: 'uint256' },
        { name: 'path', type: 'address[]' },
        { name: 'to', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
      [1000000000000000000n, 2900000000n, [TOKEN_A, TOKEN_B], USER, BigInt(deadline)],
    )
    const calldata = buildCalldata('0x38ed1739', encoded)

    it('decodes path, amounts, and deadline', () => {
      const preview = decodeTransactionPreview(calldata, ROUTER, 'sushiswap')
      expect(preview.functionName).toBe('swapExactTokensForTokens')
      expect(preview.sourceDex).toBe('Uniswap V2')
      expect(preview.tokenIn?.toLowerCase()).toBe(TOKEN_A.toLowerCase())
      expect(preview.tokenOut?.toLowerCase()).toBe(TOKEN_B.toLowerCase())
      expect(preview.amountIn).toBe('1000000000000000000')
      expect(preview.amountOutMin).toBe('2900000000')
      expect(preview.deadline).toBe(deadline)
      expect(preview.recipient?.toLowerCase()).toBe(USER.toLowerCase())
    })
  })

  // ── Msg.sender selectors ──────────────────────────

  describe('msg.sender implicit selectors', () => {
    it('sets recipientType=implicit for 1inch uniswapV3Swap', () => {
      // Just selector + minimal data (decode will fail but that's ok)
      const calldata = '0xe449022e' + '0'.repeat(256)
      const preview = decodeTransactionPreview(calldata, ROUTER, '1inch')
      expect(preview.recipientType).toBe('implicit')
      expect(preview.validated).toBe(true)
      expect(preview.functionName).toBe('uniswapV3Swap')
    })

    it('sets recipientType=implicit for 0x transformERC20', () => {
      const calldata = '0x415565b0' + '0'.repeat(256)
      const preview = decodeTransactionPreview(calldata, ROUTER, '0x')
      expect(preview.recipientType).toBe('implicit')
      expect(preview.sourceDex).toBe('0x')
    })
  })

  // ── Trusted router selectors ──────────────────────

  describe('trusted router selectors', () => {
    it('sets recipientType=implicit for Odos', () => {
      const calldata = '0x83800a8e' + '0'.repeat(256)
      const preview = decodeTransactionPreview(calldata, ROUTER, 'odos')
      expect(preview.recipientType).toBe('implicit')
      expect(preview.validated).toBe(true)
      expect(preview.sourceDex).toBe('Odos')
    })

    it('sets recipientType=implicit for KyberSwap', () => {
      const calldata = '0xe21fd0e9' + '0'.repeat(256)
      const preview = decodeTransactionPreview(calldata, ROUTER, 'kyberswap')
      expect(preview.recipientType).toBe('implicit')
      expect(preview.sourceDex).toBe('KyberSwap')
    })

    it('sets recipientType=implicit for ParaSwap megaSwap', () => {
      const calldata = '0x3598d8ab' + '0'.repeat(256)
      const preview = decodeTransactionPreview(calldata, ROUTER, 'velora')
      expect(preview.recipientType).toBe('implicit')
      expect(preview.sourceDex).toBe('ParaSwap')
    })
  })

  // ── Unknown selector ──────────────────────────────

  describe('unknown selector', () => {
    it('returns validated=false with reason', () => {
      const calldata = '0xdeadbeef' + '0'.repeat(256)
      const preview = decodeTransactionPreview(calldata, ROUTER, 'unknown-dex')
      expect(preview.validated).toBe(false)
      expect(preview.validationReason).toContain('Unknown selector')
      expect(preview.sourceDex).toBe('unknown-dex')
      expect(preview.functionName).toBe('unknown')
    })
  })

  // ── Empty / short calldata ────────────────────────

  describe('edge cases', () => {
    it('handles empty calldata', () => {
      const preview = decodeTransactionPreview('', ROUTER, 'test')
      expect(preview.validated).toBe(false)
      expect(preview.validationReason).toContain('too short')
      expect(preview.selector).toBe('none')
    })

    it('handles calldata shorter than selector', () => {
      const preview = decodeTransactionPreview('0x1234', ROUTER, 'test')
      expect(preview.validated).toBe(false)
      expect(preview.selector).toBe('none')
    })

    it('never throws on malformed calldata', () => {
      const preview = decodeTransactionPreview('0x04e45aaf' + 'zzzz', ROUTER, 'uniswap')
      // Should not throw — graceful degradation
      expect(preview.selector).toBe('0x04e45aaf')
      expect(preview.validated).toBe(true) // selector is known
      // Params may not decode but that's ok
    })
  })

  // ── SELECTOR_INFO completeness ────────────────────

  describe('SELECTOR_INFO', () => {
    it('has an entry for every validated selector', () => {
      for (const sel of VALIDATED_SELECTORS) {
        expect(SELECTOR_INFO).toHaveProperty(sel)
      }
    })
  })
})
