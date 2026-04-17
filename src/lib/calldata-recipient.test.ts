/**
 * Unit tests for calldata-recipient validation.
 *
 * [API-M-02] Covers:
 *  - Known selectors (Uniswap V3, 1inch) → valid: true, recipient extracted
 *  - msg.sender selectors → valid: true, implicitRecipient: true
 *  - Trusted router selectors (Odos, KyberSwap, ParaSwap) → valid: true, implicit
 *  - Unknown selector → valid: false (fail-closed)
 *  - Short/empty calldata → valid: false
 *  - Recipient mismatch → valid: false
 *  - VALIDATED_SELECTORS allowlist matches KNOWN_SWAP_SELECTORS
 */

import { describe, it, expect, vi } from 'vitest'
import { encodeAbiParameters, type Hex } from 'viem'
import { validateCallDataRecipient, VALIDATED_SELECTORS } from './calldata-recipient'

// ── Helpers ────────────────────────────────────────────────────

const USER_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'
const ATTACKER_ADDRESS = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

/**
 * Build a V3 exactInputSingle calldata with a specific recipient.
 * Selector: 0x04e45aaf
 */
function buildV3ExactInputSingle(recipient: string): string {
  const encoded = encodeAbiParameters(
    [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    [
      {
        tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`, // WETH
        tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`, // USDC
        fee: 3000,
        recipient: recipient as `0x${string}`,
        amountIn: 1000000000000000000n,
        amountOutMinimum: 3000000000n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  )
  return '0x04e45aaf' + encoded.slice(2)
}

/**
 * Build a 1inch swap calldata with a specific dstReceiver.
 * Selector: 0x12aa3caf
 */
function build1inchSwap(dstReceiver: string): string {
  const encoded = encodeAbiParameters(
    [
      { name: 'executor', type: 'address' },
      {
        name: 'desc',
        type: 'tuple',
        components: [
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
      '0x0000000000000000000000000000000000000001' as `0x${string}`, // executor
      {
        srcToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`,
        dstToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
        srcReceiver: '0x0000000000000000000000000000000000000002' as `0x${string}`,
        dstReceiver: dstReceiver as `0x${string}`,
        amount: 1000000000000000000n,
        minReturnAmount: 3000000000n,
        flags: 0n,
      },
      '0x' as Hex,
      '0x' as Hex,
    ],
  )
  return '0x12aa3caf' + encoded.slice(2)
}

// ── Tests ──────────────────────────────────────────────────────

describe('calldata-recipient', () => {

  // ── Known selector with extracted recipient ────────────

  describe('known selectors — recipient extraction', () => {
    it('Uniswap V3 exactInputSingle: valid when recipient matches user', () => {
      const calldata = buildV3ExactInputSingle(USER_ADDRESS)
      const result = validateCallDataRecipient(calldata, USER_ADDRESS)

      expect(result.valid).toBe(true)
      expect(result.extracted?.toLowerCase()).toBe(USER_ADDRESS.toLowerCase())
      expect(result.implicitRecipient).toBe(false)
    })

    it('Uniswap V3 exactInputSingle: invalid when recipient mismatches', () => {
      const calldata = buildV3ExactInputSingle(ATTACKER_ADDRESS)
      const result = validateCallDataRecipient(calldata, USER_ADDRESS)

      expect(result.valid).toBe(false)
      expect(result.extracted?.toLowerCase()).toBe(ATTACKER_ADDRESS.toLowerCase())
      expect(result.reason).toContain('does not match')
    })

    it('1inch swap: valid when dstReceiver matches user', () => {
      const calldata = build1inchSwap(USER_ADDRESS)
      const result = validateCallDataRecipient(calldata, USER_ADDRESS)

      expect(result.valid).toBe(true)
      expect(result.extracted?.toLowerCase()).toBe(USER_ADDRESS.toLowerCase())
    })

    it('1inch swap: invalid when dstReceiver mismatches', () => {
      const calldata = build1inchSwap(ATTACKER_ADDRESS)
      const result = validateCallDataRecipient(calldata, USER_ADDRESS)

      expect(result.valid).toBe(false)
      expect(result.reason).toContain('does not match')
    })
  })

  // ── msg.sender implicit selectors (Group A) ───────────

  describe('msg.sender selectors (Group A)', () => {
    const msgSenderSelectors = [
      { selector: '0xe449022e', name: '1inch uniswapV3Swap' },
      { selector: '0x0502b1c5', name: '1inch unoswap' },
      { selector: '0xd9627aa4', name: '0x sellToUniswap' },
      { selector: '0x415565b0', name: '0x transformERC20' },
    ]

    for (const { selector, name } of msgSenderSelectors) {
      it(`${name} (${selector}) → valid: true, implicitRecipient: true`, () => {
        // Append dummy data (64 bytes) to make valid calldata length
        const calldata = selector + '0'.repeat(128)
        const result = validateCallDataRecipient(calldata, USER_ADDRESS)

        expect(result.valid).toBe(true)
        expect(result.implicitRecipient).toBe(true)
        expect(result.extracted).toBeNull()
      })
    }
  })

  // ── Trusted router selectors (Group F, ex-unsupported) ─

  describe('trusted router selectors (Group F)', () => {
    const trustedSelectors = [
      { selector: '0x83800a8e', name: 'Odos' },
      { selector: '0xe21fd0e9', name: 'KyberSwap' },
      { selector: '0x3598d8ab', name: 'ParaSwap megaSwap' },
      { selector: '0xa94e78ef', name: 'ParaSwap multiSwap' },
      { selector: '0x46c67b6d', name: 'ParaSwap simpleSwap' },
    ]

    for (const { selector, name } of trustedSelectors) {
      it(`${name} (${selector}) → valid: true, implicitRecipient: true`, () => {
        const calldata = selector + '0'.repeat(128)
        const result = validateCallDataRecipient(calldata, USER_ADDRESS)

        expect(result.valid).toBe(true)
        expect(result.implicitRecipient).toBe(true)
        expect(result.extracted).toBeNull()
      })
    }
  })

  // ── Unknown selector — fail-closed ─────────────────────

  describe('[API-M-02] unknown selector — fail-closed', () => {
    it('unknown selector returns valid: false', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const calldata = '0xdeadbeef' + '0'.repeat(128)
      const result = validateCallDataRecipient(calldata, USER_ADDRESS)

      expect(result.valid).toBe(false)
      expect(result.extracted).toBeNull()
      expect(result.reason).toContain('Unknown selector')
      expect(result.reason).toContain('0xdeadbeef')
      expect(result.reason).toContain('not in validated allowlist')
      consoleSpy.mockRestore()
    })

    it('logs blocked selector for future analysis', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const calldata = '0xabababab' + '0'.repeat(128)
      validateCallDataRecipient(calldata, USER_ADDRESS)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Blocked unknown selector 0xabababab'),
      )
      consoleSpy.mockRestore()
    })
  })

  // ── Short/empty calldata — fail-closed ────────────────

  describe('short/empty calldata — fail-closed', () => {
    it('empty string → valid: false', () => {
      const result = validateCallDataRecipient('', USER_ADDRESS)
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('too short')
    })

    it('short hex → valid: false', () => {
      const result = validateCallDataRecipient('0x1234', USER_ADDRESS)
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('too short')
    })
  })

  // ── Decode error — fail-closed ────────────────────────

  describe('decode error — fail-closed', () => {
    it('malformed calldata for known selector → valid: false', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // V3 exactInputSingle selector with garbage data
      const calldata = '0x04e45aaf' + 'ff'.repeat(10)
      const result = validateCallDataRecipient(calldata, USER_ADDRESS)

      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Decode error')
      consoleSpy.mockRestore()
    })
  })

  // ── VALIDATED_SELECTORS allowlist ──────────────────────

  describe('VALIDATED_SELECTORS allowlist', () => {
    it('contains exactly 19 selectors (all known swap selectors)', () => {
      expect(VALIDATED_SELECTORS.size).toBe(19)
    })

    it('matches KNOWN_SWAP_SELECTORS from swap-selectors.ts', async () => {
      const { KNOWN_SWAP_SELECTORS } = await import('./swap-selectors')
      // Every known swap selector should be in the validated set
      for (const sel of KNOWN_SWAP_SELECTORS) {
        expect(VALIDATED_SELECTORS.has(sel)).toBe(true)
      }
      // Every validated selector should be in the known swap set
      for (const sel of VALIDATED_SELECTORS) {
        expect(KNOWN_SWAP_SELECTORS.has(sel)).toBe(true)
      }
    })
  })
})
