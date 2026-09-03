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

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem'
import {
  validateCallDataRecipient,
  validateCallDataRecipientAsync,
  VALIDATED_SELECTORS,
  ALLOWANCE_HOLDER_EXEC_SELECTOR,
  ALLOWANCE_HOLDER_INNER_SELECTORS,
} from './calldata-recipient'
import { FEE_COLLECTOR_ADDRESS } from '@/lib/constants'
import { ROUTER_WHITELIST_BY_CHAIN } from '@/lib/chains/routers'
import { resolveZeroxSettlers } from '@/lib/zerox-settler-registry'
import {
  ZEROX_MAINNET_EXEC_CALLDATA,
  ZEROX_MAINNET_EXEC_TAKER,
  ZEROX_MAINNET_EXEC_BLOCK,
  ZEROX_MAINNET_SETTLER_CURRENT,
  ZEROX_MAINNET_SETTLER_PREV,
} from './__fixtures__/zerox-allowance-holder-mainnet'
import {
  ZEROX_BASE_EXEC_CALLDATA,
  ZEROX_BASE_EXEC_TAKER,
  ZEROX_BASE_EXEC_BLOCK,
  ZEROX_BASE_SETTLER_CURRENT,
  ZEROX_BASE_SETTLER_PREV,
} from './__fixtures__/zerox-allowance-holder-base'
import {
  ZEROX_ARBITRUM_EXEC_CALLDATA,
  ZEROX_ARBITRUM_EXEC_TAKER,
  ZEROX_ARBITRUM_EXEC_BLOCK,
  ZEROX_ARBITRUM_SETTLER_CURRENT,
  ZEROX_ARBITRUM_SETTLER_PREV,
} from './__fixtures__/zerox-allowance-holder-arbitrum'

// [ADR-023] The registry is MOCKED everywhere in this file — no test issues an
// RPC. The addresses fed in are the real per-chain answers read on 2026-09-03,
// pinned in the fixtures alongside the calldata they belong to.
vi.mock('@/lib/zerox-settler-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/zerox-settler-registry')>()
  return { ...actual, resolveZeroxSettlers: vi.fn() }
})

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

  // ── [SEC-04] Nested multicall — fail-closed ───────────

  describe('[SEC-04] nested multicall — fail-closed', () => {
    // Build a single multicall(bytes[]) wrapper around an arbitrary inner
    // calldata blob. selector=0xac9650d8 matches MULTICALL_SELECTORS in
    // calldata-recipient.ts so the validator follows the recursion path.
    function buildMulticall(innerCalldataHexNo0x: string): string {
      const encoded = encodeAbiParameters(
        [{ name: 'data', type: 'bytes[]' }],
        [[`0x${innerCalldataHexNo0x}` as Hex]],
      )
      return '0xac9650d8' + encoded.slice(2)
    }

    it('depth-0 multicall wrapping a known swap still validates normally', () => {
      // Sanity: the depth-0 case must continue to work — only depth > 0
      // is being made stricter.
      const innerSwap = buildV3ExactInputSingle(USER_ADDRESS).slice(2)
      const calldata = buildMulticall(innerSwap)

      const result = validateCallDataRecipient(calldata, USER_ADDRESS)
      expect(result.valid).toBe(true)
      expect(result.extracted?.toLowerCase()).toBe(USER_ADDRESS.toLowerCase())
    })

    it('nested multicall(multicall(swap)) is rejected (fail-closed)', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const innerSwap = buildV3ExactInputSingle(USER_ADDRESS).slice(2)
      const innerMulticall = buildMulticall(innerSwap).slice(2)
      const outer = buildMulticall(innerMulticall)

      const result = validateCallDataRecipient(outer, USER_ADDRESS)

      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Nested multicall rejected')
      expect(result.reason).toContain('depth > 0')
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SEC-04] Nested multicall rejected at depth'),
      )

      consoleSpy.mockRestore()
    })

    it('nested multicall is rejected even when the inner recipient would have matched', () => {
      // Defence-in-depth check: a malicious adapter could craft an inner
      // swap with the *correct* recipient to satisfy a naive validator
      // that gave up on nesting. The fail-closed path means the result is
      // valid: false regardless of inner contents.
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const innerSwap = buildV3ExactInputSingle(USER_ADDRESS).slice(2)
      const innerMulticall = buildMulticall(innerSwap).slice(2)
      const outer = buildMulticall(innerMulticall)

      const result = validateCallDataRecipient(outer, USER_ADDRESS)
      expect(result.valid).toBe(false)

      consoleSpy.mockRestore()
    })
  })

  // ── [FULL-M-01] routeViaFeeCollector gating ────────────

  describe('[FULL-M-01] FeeCollector recipient gating by route type', () => {
    it('rejects FeeCollector recipient on direct route', () => {
      // Calldata that would deliver output to the FeeCollector contract.
      const calldata = buildV3ExactInputSingle(FEE_COLLECTOR_ADDRESS)
      // Direct route (routeViaFeeCollector=false): the FeeCollector must NOT
      // be an accepted recipient — only the user's wallet.
      const result = validateCallDataRecipient(calldata, USER_ADDRESS, false)

      expect(result.valid).toBe(false)
      expect(result.extracted?.toLowerCase()).toBe(FEE_COLLECTOR_ADDRESS.toLowerCase())
      expect(result.reason).toContain('does not match')
    })

    it('accepts FeeCollector recipient on fee-routed swap', () => {
      const calldata = buildV3ExactInputSingle(FEE_COLLECTOR_ADDRESS)
      // Fee-routed swap (routeViaFeeCollector=true): the FeeCollector is a
      // legitimate recipient because it forwards output to the user.
      const result = validateCallDataRecipient(calldata, USER_ADDRESS, true)

      expect(result.valid).toBe(true)
      expect(result.extracted?.toLowerCase()).toBe(FEE_COLLECTOR_ADDRESS.toLowerCase())
    })

    it('still accepts the user wallet on a direct route', () => {
      // Sanity: tightening the FeeCollector path must not break the normal
      // direct-route case where output goes straight to the user.
      const calldata = buildV3ExactInputSingle(USER_ADDRESS)
      const result = validateCallDataRecipient(calldata, USER_ADDRESS, false)
      expect(result.valid).toBe(true)
    })
  })

  // ── Group G — 0x v2 AllowanceHolder.exec ───────────────

  /**
   * [R1 Group G] `exec` carries no recipient of its own; the destination is
   * `AllowedSlippage.recipient`, field 0 of the tuple in the Settler `execute`
   * call nested in `exec`'s `data` argument.
   *
   * Shape derived from 0x's published source, pinned at
   * 0xProject/0x-settler@1df908742d38cf407f667df6518dae6e04a01ac3:
   *   src/allowanceholder/IAllowanceHolder.sol   → exec(...)
   *   src/interfaces/ISettlerTakerSubmitted.sol  → execute(AllowedSlippage,bytes[],bytes32)
   *   src/interfaces/ISettlerBase.sol            → struct AllowedSlippage
   *
   * Cross-checked against REAL mainnet calldata (see EXEC_CALLDATA_SHAPE below).
   */
  describe('[Group G] 0x v2 AllowanceHolder.exec', () => {
    // Every selector here is recomputed from its signature, never typed.
    const EXEC_ABI = parseAbi([
      'function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes)',
    ])
    const SETTLER_ABI = parseAbi([
      'function execute((address,address,uint256) slippage, bytes[] actions, bytes32 zid) payable returns (bool)',
    ])
    const EXECUTE_SELECTOR = toFunctionSelector('execute((address,address,uint256),bytes[],bytes32)')

    // [ADR-023] The admitted counterparties are no longer whitelist entries —
    // they are what 0x's deployer/registry answers for feature 2 on this chain.
    // These are the REAL mainnet answers at the golden vector's block.
    const CURRENT_SETTLER = ZEROX_MAINNET_SETTLER_CURRENT
    const PREV_SETTLER = ZEROX_MAINNET_SETTLER_PREV
    const MAINNET_SETTLERS: ReadonlySet<string> = new Set([
      CURRENT_SETTLER.toLowerCase(),
      PREV_SETTLER.toLowerCase(),
    ])

    // The AllowanceHolder itself — a whitelisted router, and NOT a Settler. It
    // is `tx.to`, never `exec`'s target, so Group G must reject it as a target.
    const ALLOWANCE_HOLDER = ROUTER_WHITELIST_BY_CHAIN[1]['0x']

    /**
     * Every Group G case runs against a MOCKED resolved set — the sync entry
     * point takes it as an input, so no test here touches an RPC.
     */
    const check = (
      calldata: string,
      expected: string,
      routeViaFeeCollector = false,
      zeroxSettlers: ReadonlySet<string> | undefined = MAINNET_SETTLERS,
    ) => validateCallDataRecipient(calldata, expected, routeViaFeeCollector, 1, { zeroxSettlers })

    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

    function buildSettlerExecute(recipient: string, minAmountOut = 3000000000n): Hex {
      return encodeFunctionData({
        abi: SETTLER_ABI,
        functionName: 'execute',
        args: [
          [recipient as `0x${string}`, USDC as `0x${string}`, minAmountOut],
          ['0x' as Hex],
          `0x${'11'.repeat(32)}` as Hex,
        ],
      })
    }

    function buildExec(opts: {
      recipient?: string
      target?: string
      operator?: string
      inner?: Hex
      minAmountOut?: bigint
    }): string {
      const target = (opts.target ?? PREV_SETTLER) as `0x${string}`
      const operator = (opts.operator ?? target) as `0x${string}`
      const inner =
        opts.inner ?? buildSettlerExecute(opts.recipient ?? USER_ADDRESS, opts.minAmountOut)
      return encodeFunctionData({
        abi: EXEC_ABI,
        functionName: 'exec',
        args: [operator, WETH as `0x${string}`, 1000000000000000000n, target, inner],
      })
    }

    /** Replace `operator` (arg 0) and `target` (arg 3) in raw exec calldata. */
    function retarget(calldata: string, address: string): string {
      const word = (i: number) => 10 + i * 64
      const padded = address.toLowerCase().slice(2).padStart(64, '0')
      const chars = calldata.split('')
      for (const i of [0, 3]) {
        chars.splice(word(i), 64, ...padded.split(''))
      }
      return chars.join('')
    }

    // ── Selector derivation (acceptance: never typed) ──

    it('the handled outer selector is exec(address,address,uint256,address,bytes)', () => {
      expect(ALLOWANCE_HOLDER_EXEC_SELECTOR).toBe(
        toFunctionSelector('exec(address,address,uint256,address,bytes)'),
      )
      // …and it is the exact selector SC-04 admits, computed independently there.
      expect(buildExec({}).slice(0, 10)).toBe(ALLOWANCE_HOLDER_EXEC_SELECTOR)
    })

    it('the inner allowlist holds exactly the Settler execute() selector', () => {
      expect([...ALLOWANCE_HOLDER_INNER_SELECTORS]).toEqual([EXECUTE_SELECTOR])
    })

    it('does NOT admit executeWithPermit or executeMetaTxn (no signing on this swap path)', () => {
      // Both are real Settler entry points; neither is emittable by TeraSwap.
      expect(
        ALLOWANCE_HOLDER_INNER_SELECTORS.has(
          toFunctionSelector('executeWithPermit((address,address,uint256),bytes[],bytes32,bytes)'),
        ),
      ).toBe(false)
      expect(
        ALLOWANCE_HOLDER_INNER_SELECTORS.has(
          toFunctionSelector('executeMetaTxn((address,address,uint256),bytes[],bytes32,address,bytes)'),
        ),
      ).toBe(false)
    })

    // ── Acceptance 1 — both controls ──

    it('ACCEPTS exec whose nested AllowedSlippage.recipient is the user', () => {
      const result = check(buildExec({ recipient: USER_ADDRESS }), USER_ADDRESS, false)
      expect(result.valid).toBe(true)
      expect(result.extracted?.toLowerCase()).toBe(USER_ADDRESS.toLowerCase())
      // Extracted, NOT assumed: exec must never be classified msg.sender-implicit.
      expect(result.implicitRecipient).toBe(false)
    })

    it('REJECTS the same calldata with an attacker recipient', () => {
      const result = check(buildExec({ recipient: ATTACKER_ADDRESS }), USER_ADDRESS, false)
      expect(result.valid).toBe(false)
      expect(result.extracted?.toLowerCase()).toBe(ATTACKER_ADDRESS.toLowerCase())
      expect(result.reason).toContain('does not match expected')
    })

    it('honours routeViaFeeCollector — the FeeCollector is a recipient only on fee routes', () => {
      if (!FEE_COLLECTOR_ADDRESS) return
      const calldata = buildExec({ recipient: FEE_COLLECTOR_ADDRESS })
      expect(check(calldata, USER_ADDRESS, true).valid).toBe(true)
      expect(check(calldata, USER_ADDRESS, false).valid).toBe(false)
    })

    // ── Nested amount integrity — minAmountOut ──

    it('REJECTS a zero minAmountOut with its own reason', () => {
      const result = check(
        buildExec({ recipient: USER_ADDRESS, minAmountOut: 0n }),
        USER_ADDRESS,
        false,
      )
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('zero minAmountOut')
    })

    it('ACCEPTS a non-zero minAmountOut', () => {
      const result = check(
        buildExec({ recipient: USER_ADDRESS, minAmountOut: 1n }),
        USER_ADDRESS,
        false,
      )
      expect(result.valid).toBe(true)
    })

    it('the golden vector carries a non-zero minAmountOut and is unaffected by the guard', () => {
      const calldata = ZEROX_MAINNET_EXEC_CALLDATA
      const result = check(calldata, ZEROX_MAINNET_EXEC_TAKER, false)
      expect(result.valid).toBe(true)
    })

    // ── Acceptance 2 — three distinct fail-closed reasons ──

    it('REJECTS a non-Settler target with a target-specific reason', () => {
      const result = check(
        buildExec({ recipient: USER_ADDRESS, target: ATTACKER_ADDRESS }),
        USER_ADDRESS,
        false,
      )
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('exec target')
      expect(result.reason).toContain('not the current or previous 0x Settler')
    })

    it('REJECTS a non-Settler operator even when the target is a Settler', () => {
      // operator is the address allowed to pull the taker's tokens back out of
      // the AllowanceHolder — a genuine target does not make it safe.
      // [ADR-023] It is now held to the registry-derived identity, which is
      // strictly narrower than the router whitelist ADR-022 checked it against.
      const result = check(
        buildExec({ recipient: USER_ADDRESS, operator: ATTACKER_ADDRESS }),
        USER_ADDRESS,
        false,
      )
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('exec operator')
      expect(result.reason).toContain('not the current or previous 0x Settler')
    })

    // ── [ADR-022 interim] operator === target narrowing ──

    it('REJECTS operator !== target with a distinct reason even when BOTH are admitted Settlers', () => {
      // [ADR-022, kept by ADR-023] Both addresses are in the resolved registry
      // set, so checks (1) and (2) pass and this exercises the narrowing itself
      // — the case that proves the registry check does not subsume it.
      const result = check(
        buildExec({
          recipient: USER_ADDRESS,
          target: PREV_SETTLER,
          operator: CURRENT_SETTLER,
        }),
        USER_ADDRESS,
        false,
      )
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('operator')
      expect(result.reason).toContain('does not match target')
    })

    it('ACCEPTS operator === target on the golden vector (unaffected by the narrowing)', () => {
      const calldata = ZEROX_MAINNET_EXEC_CALLDATA
      const result = check(calldata, ZEROX_MAINNET_EXEC_TAKER, false)
      expect(result.valid).toBe(true)
    })

    it('REJECTS an unknown inner selector with an inner-selector-specific reason', () => {
      // A Uniswap V3 exactInputSingle would be perfectly valid as OUTER calldata;
      // through exec it is an unknown shape and must fail closed.
      const result = check(
        buildExec({ inner: buildV3ExactInputSingle(USER_ADDRESS) as Hex }),
        USER_ADDRESS,
        false,
      )
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('inner selector')
      expect(result.reason).toContain('not in the Settler allowlist')
    })

    it('REJECTS empty inner bytes with a too-short reason', () => {
      const result = check(buildExec({ inner: '0x' as Hex }), USER_ADDRESS, false)
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('too short to contain a selector')
    })

    it('REJECTS malformed inner bytes behind a valid inner selector (decode error)', () => {
      // Right selector, truncated tuple → decodeAbiParameters throws → fail closed.
      const result = check(
        buildExec({ inner: `${EXECUTE_SELECTOR}${'00'.repeat(32)}` as Hex }),
        USER_ADDRESS,
        false,
      )
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Decode error')
      expect(result.extracted).toBeNull()
    })

    it('REJECTS malformed OUTER exec args (decode error, never a pass)', () => {
      const result = check(
        `${ALLOWANCE_HOLDER_EXEC_SELECTOR}${'00'.repeat(32)}`,
        USER_ADDRESS,
        false,
      )
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Decode error')
    })

    // ── Depth: Group G is a leaf, it does not spend or extend the budget ──

    it('an exec nested in a multicall is still validated, and still cannot recurse further', () => {
      // Group G is a leaf — it does not call back into the validator — so an exec
      // reached through Group E's ONE level of recursion is fully checked, and the
      // depth budget is neither consumed further nor raised.
      const wrapInMulticall = (inner: string): string => {
        const encoded = encodeAbiParameters(
          [{ name: 'data', type: 'bytes[]' }],
          [[inner as Hex]],
        )
        return '0xac9650d8' + encoded.slice(2)
      }
      expect(
        check(
          wrapInMulticall(buildExec({ recipient: USER_ADDRESS })),
          USER_ADDRESS,
          false,
        ).valid,
      ).toBe(true)
      expect(
        check(
          wrapInMulticall(buildExec({ recipient: ATTACKER_ADDRESS })),
          USER_ADDRESS,
          false,
        ).valid,
      ).toBe(false)
    })

    // ── The remaining production blocker, pinned ──

    // ── Golden vector — real mainnet bytes, not a hand-written mock ──

    describe('golden vector: real mainnet exec calldata', () => {
      it('decodes to the shape Group G assumes (independent viem decode)', () => {
        expect(ZEROX_MAINNET_EXEC_CALLDATA.slice(0, 10)).toBe(ALLOWANCE_HOLDER_EXEC_SELECTOR)

        const [operator, , , target, inner] = decodeAbiParameters(
          [
            { name: 'operator', type: 'address' },
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'target', type: 'address' },
            { name: 'data', type: 'bytes' },
          ],
          `0x${ZEROX_MAINNET_EXEC_CALLDATA.slice(10)}` as Hex,
        )
        expect(operator.toLowerCase()).toBe(target.toLowerCase())
        expect(inner.slice(0, 10)).toBe(EXECUTE_SELECTOR)

        const [slippage] = decodeAbiParameters(
          [
            {
              name: 'slippage',
              type: 'tuple',
              components: [
                { name: 'recipient', type: 'address' },
                { name: 'buyToken', type: 'address' },
                { name: 'minAmountOut', type: 'uint256' },
              ],
            },
            { name: 'actions', type: 'bytes[]' },
            { name: 'zid', type: 'bytes32' },
          ],
          `0x${inner.slice(10)}` as Hex,
        )
        // The whole point of Group G: field 0 of the inner tuple is the taker.
        expect(slippage.recipient.toLowerCase()).toBe(ZEROX_MAINNET_EXEC_TAKER.toLowerCase())
      })

      it('[ADR-023] AS-CAPTURED it is now ACCEPTED — 0x is executable end-to-end', () => {
        // The bytes are untouched: no retarget, no rewrite. This is the exact
        // calldata 0x API emitted for a real taker on mainnet, and the gate
        // that used to reject it (a static allowlist that could never hold a
        // rotating address) now asks 0x's own registry instead.
        const result = check(
          ZEROX_MAINNET_EXEC_CALLDATA,
          ZEROX_MAINNET_EXEC_TAKER,
          false,
        )
        expect(result.valid).toBe(true)
        expect(result.extracted?.toLowerCase()).toBe(ZEROX_MAINNET_EXEC_TAKER.toLowerCase())

        // …and the same bytes are still rejected for anybody else.
        expect(check(ZEROX_MAINNET_EXEC_CALLDATA, ATTACKER_ADDRESS, false).valid).toBe(false)
      })

      it('retargeted onto an attacker contract, the very same bytes are REJECTED', () => {
        // Real 0x calldata is not a free pass: rewrite only the operator and
        // target words — every byte of the inner Settler call, including the
        // taker in AllowedSlippage.recipient, stays exactly as 0x emitted it —
        // and the registry check refuses it.
        const hijacked = retarget(ZEROX_MAINNET_EXEC_CALLDATA, ATTACKER_ADDRESS)
        const result = check(hijacked, ZEROX_MAINNET_EXEC_TAKER, false)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('not the current or previous 0x Settler')
      })

      it('it targets prev(2), NOT ownerOf(2) — the dwell window is why prev is admitted', () => {
        // Pinned because it is the whole argument for accepting `prev`: at
        // block ZEROX_MAINNET_EXEC_BLOCK an ownerOf-only check would have
        // rejected this real, successful mainnet swap.
        const [operator, , , target] = decodeAbiParameters(
          [
            { name: 'operator', type: 'address' },
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'target', type: 'address' },
            { name: 'data', type: 'bytes' },
          ],
          `0x${ZEROX_MAINNET_EXEC_CALLDATA.slice(10)}` as Hex,
        )
        expect(target.toLowerCase()).toBe(PREV_SETTLER.toLowerCase())
        expect(target.toLowerCase()).not.toBe(CURRENT_SETTLER.toLowerCase())
        expect(operator.toLowerCase()).toBe(target.toLowerCase())
        expect(ZEROX_MAINNET_EXEC_BLOCK).toBe(25897835n)

        // ownerOf alone would have blocked it.
        const ownerOfOnly: ReadonlySet<string> = new Set([CURRENT_SETTLER.toLowerCase()])
        const result = check(
          ZEROX_MAINNET_EXEC_CALLDATA,
          ZEROX_MAINNET_EXEC_TAKER,
          false,
          ownerOfOnly,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('not the current or previous 0x Settler')
      })
    })

    // ── [ADR-023] Acceptance 1 — registry-derived identity, registry MOCKED ──

    describe('[ADR-023] Settler identity comes from the registry', () => {
      it('ACCEPTS the CURRENT Settler — ownerOf(2)', () => {
        const result = check(
          buildExec({ recipient: USER_ADDRESS, target: CURRENT_SETTLER }),
          USER_ADDRESS,
        )
        expect(result.valid).toBe(true)
      })

      it('ACCEPTS the PREVIOUS Settler — prev(2), the dwell window', () => {
        const result = check(
          buildExec({ recipient: USER_ADDRESS, target: PREV_SETTLER }),
          USER_ADDRESS,
        )
        expect(result.valid).toBe(true)
      })

      it('REJECTS an arbitrary address with its own registry-specific reason', () => {
        const result = check(
          buildExec({ recipient: USER_ADDRESS, target: ATTACKER_ADDRESS }),
          USER_ADDRESS,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('exec target')
        expect(result.reason).toContain('not the current or previous 0x Settler')
        // The reason is distinct from every sibling Group G reason.
        expect(result.reason).not.toContain('whitelisted router')
      })

      it('REJECTS the AllowanceHolder itself as a target — whitelisted is not Settler', () => {
        // Before ADR-023 this address PASSED the target check, because the
        // check was "is it a whitelisted router". It is `tx.to`, never exec's
        // target, and the registry has never named it.
        const result = check(
          buildExec({ recipient: USER_ADDRESS, target: ALLOWANCE_HOLDER }),
          USER_ADDRESS,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('not the current or previous 0x Settler')
      })

      it('REJECTS a whitelisted router that is not a Settler — the whitelist no longer admits', () => {
        const velora = ROUTER_WHITELIST_BY_CHAIN[1]['velora']
        const result = check(
          buildExec({ recipient: USER_ADDRESS, target: velora }),
          USER_ADDRESS,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('not the current or previous 0x Settler')
      })

      it('REJECTS when NO set was resolved — a caller that forgets fails closed', () => {
        // Called through the raw sync entry point with NO options at all, i.e.
        // exactly what a caller that skipped the registry would produce.
        const result = validateCallDataRecipient(
          buildExec({ recipient: USER_ADDRESS, target: CURRENT_SETTLER }),
          USER_ADDRESS,
          false,
          1,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('no 0x Settler resolved from the registry')
      })

      it('REJECTS when the resolved set is empty', () => {
        const result = check(
          buildExec({ recipient: USER_ADDRESS, target: CURRENT_SETTLER }),
          USER_ADDRESS,
          false,
          new Set<string>(),
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('no 0x Settler resolved from the registry')
      })

      it('REJECTS another chain’s Settler — the set is per chain', () => {
        const result = check(
          buildExec({ recipient: USER_ADDRESS, target: ZEROX_BASE_SETTLER_PREV }),
          USER_ADDRESS,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('not the current or previous 0x Settler')
      })

      // ── [ADR-022, KEPT] The narrowing the registry does NOT dominate ──

      it('REJECTS operator = ownerOf(2) paired with target = prev(2)', () => {
        // Both are in the resolved set, so checks (1) and (2) pass. The pair is
        // still a shape 0x never emits — this is exactly the case that proves
        // the registry check does not subsume #473's operator === target.
        const result = check(
          buildExec({
            recipient: USER_ADDRESS,
            target: PREV_SETTLER,
            operator: CURRENT_SETTLER,
          }),
          USER_ADDRESS,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('does not match target')
      })

      it('REJECTS an operator that is not a Settler even when the target is', () => {
        const result = check(
          buildExec({
            recipient: USER_ADDRESS,
            target: CURRENT_SETTLER,
            operator: ATTACKER_ADDRESS,
          }),
          USER_ADDRESS,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('exec operator')
        expect(result.reason).toContain('not the current or previous 0x Settler')
      })
    })

    // ── [ADR-023] Acceptance 3 — one golden vector per chain ──

    describe('[ADR-023] golden vectors — real exec calldata per chain', () => {
      const cases = [
        {
          chain: 'Ethereum mainnet',
          chainId: 1,
          calldata: ZEROX_MAINNET_EXEC_CALLDATA,
          taker: ZEROX_MAINNET_EXEC_TAKER,
          block: ZEROX_MAINNET_EXEC_BLOCK,
          current: ZEROX_MAINNET_SETTLER_CURRENT,
          prev: ZEROX_MAINNET_SETTLER_PREV,
        },
        {
          chain: 'Base',
          chainId: 8453,
          calldata: ZEROX_BASE_EXEC_CALLDATA,
          taker: ZEROX_BASE_EXEC_TAKER,
          block: ZEROX_BASE_EXEC_BLOCK,
          current: ZEROX_BASE_SETTLER_CURRENT,
          prev: ZEROX_BASE_SETTLER_PREV,
        },
        {
          chain: 'Arbitrum One',
          chainId: 42161,
          calldata: ZEROX_ARBITRUM_EXEC_CALLDATA,
          taker: ZEROX_ARBITRUM_EXEC_TAKER,
          block: ZEROX_ARBITRUM_EXEC_BLOCK,
          current: ZEROX_ARBITRUM_SETTLER_CURRENT,
          prev: ZEROX_ARBITRUM_SETTLER_PREV,
        },
      ] as const

      for (const c of cases) {
        it(`${c.chain} (chain ${c.chainId}) @ block ${c.block}: real calldata + registry answer`, () => {
          const settlers: ReadonlySet<string> = new Set([
            c.current.toLowerCase(),
            c.prev.toLowerCase(),
          ])
          expect(c.calldata.slice(0, 10)).toBe(ALLOWANCE_HOLDER_EXEC_SELECTOR)

          const result = validateCallDataRecipient(c.calldata, c.taker, false, c.chainId, {
            zeroxSettlers: settlers,
          })
          expect(result.valid).toBe(true)
          expect(result.extracted?.toLowerCase()).toBe(c.taker.toLowerCase())

          // Every chain was inside the dwell window on 2026-09-03.
          const [, , , target] = decodeAbiParameters(
            [
              { name: 'operator', type: 'address' },
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'target', type: 'address' },
              { name: 'data', type: 'bytes' },
            ],
            `0x${c.calldata.slice(10)}` as Hex,
          )
          expect(target.toLowerCase()).toBe(c.prev.toLowerCase())

          // …and nobody else's wallet gets the output.
          expect(
            validateCallDataRecipient(c.calldata, ATTACKER_ADDRESS, false, c.chainId, {
              zeroxSettlers: settlers,
            }).valid,
          ).toBe(false)
        })
      }
    })

    // ── [ADR-023] The async entry point that resolves the set ──

    describe('[ADR-023] validateCallDataRecipientAsync', () => {
      const mockedResolve = vi.mocked(resolveZeroxSettlers)

      beforeEach(() => {
        mockedResolve.mockReset()
      })

      it('resolves the registry for exec calldata and accepts the live Settler', async () => {
        mockedResolve.mockResolvedValue(MAINNET_SETTLERS)
        const result = await validateCallDataRecipientAsync(
          ZEROX_MAINNET_EXEC_CALLDATA,
          ZEROX_MAINNET_EXEC_TAKER,
          false,
          1,
        )
        expect(result.valid).toBe(true)
        expect(mockedResolve).toHaveBeenCalledWith(1)
      })

      it('REJECTS the swap when the registry lookup throws', async () => {
        mockedResolve.mockRejectedValue(new Error('rpc down'))
        const result = await validateCallDataRecipientAsync(
          ZEROX_MAINNET_EXEC_CALLDATA,
          ZEROX_MAINNET_EXEC_TAKER,
          false,
          1,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('registry lookup failed on chain 1')
        expect(result.reason).toContain('rpc down')
      })

      it('REJECTS the swap when the registry resolves to an empty set', async () => {
        mockedResolve.mockResolvedValue(new Set<string>())
        const result = await validateCallDataRecipientAsync(
          ZEROX_MAINNET_EXEC_CALLDATA,
          ZEROX_MAINNET_EXEC_TAKER,
          false,
          1,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('no 0x Settler resolved from the registry')
      })

      it('issues NO registry read for calldata that cannot reach Group G', async () => {
        const result = await validateCallDataRecipientAsync(
          buildV3ExactInputSingle(USER_ADDRESS),
          USER_ADDRESS,
          false,
          1,
        )
        expect(result.valid).toBe(true)
        expect(mockedResolve).not.toHaveBeenCalled()
      })

      it('a multicall wrapping an exec is still validated against the registry', async () => {
        mockedResolve.mockResolvedValue(MAINNET_SETTLERS)
        const encoded = encodeAbiParameters(
          [{ name: 'data', type: 'bytes[]' }],
          [[buildExec({ recipient: USER_ADDRESS }) as Hex]],
        )
        const result = await validateCallDataRecipientAsync(
          `0xac9650d8${encoded.slice(2)}`,
          USER_ADDRESS,
          false,
          1,
        )
        expect(result.valid).toBe(true)
        expect(mockedResolve).toHaveBeenCalledWith(1)
      })

      it('a failed lookup does not blanket-block a multicall that holds no exec', async () => {
        // An RPC blip must not take Uniswap's multicall down with 0x. The
        // nested exec case still fails closed inside Group G — proven above.
        mockedResolve.mockRejectedValue(new Error('rpc down'))
        const encoded = encodeAbiParameters(
          [{ name: 'data', type: 'bytes[]' }],
          [[buildV3ExactInputSingle(USER_ADDRESS) as Hex]],
        )
        const result = await validateCallDataRecipientAsync(
          `0xac9650d8${encoded.slice(2)}`,
          USER_ADDRESS,
          false,
          1,
        )
        expect(result.valid).toBe(true)
      })

      it('a failed lookup DOES block a multicall that holds an exec', async () => {
        mockedResolve.mockRejectedValue(new Error('rpc down'))
        const encoded = encodeAbiParameters(
          [{ name: 'data', type: 'bytes[]' }],
          [[buildExec({ recipient: USER_ADDRESS }) as Hex]],
        )
        const result = await validateCallDataRecipientAsync(
          `0xac9650d8${encoded.slice(2)}`,
          USER_ADDRESS,
          false,
          1,
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('no 0x Settler resolved from the registry')
      })
    })
  })

  // ── VALIDATED_SELECTORS allowlist ──────────────────────

  describe('VALIDATED_SELECTORS allowlist', () => {
    it('contains exactly 23 selectors', () => {
      // [SPRINT-9H] 20 → 22: + Augustus V6.2 swapExactAmountInOnCurveV1/V2.
      // [R1 Group G] 22 → 23: + AllowanceHolder.exec, which this gate can now
      // decode. ADR-021's one-release divergence from SC-04 is closed.
      expect(VALIDATED_SELECTORS.size).toBe(23)
    })

    it('matches KNOWN_SWAP_SELECTORS exactly — the R1 ≡ SC-04 invariant', async () => {
      const { KNOWN_SWAP_SELECTORS } = await import('./swap-selectors')

      // [R1 Group G] The equality assertion, restored. ADR-021 had to relax it for
      // one release: SC-04 admitted AllowanceHolder.exec while this gate could not
      // yet decode it, so /api/swap cleared SC-04 and the router whitelist and then
      // 400'd here. Group G closed that, and the assertion goes back to EQUALITY
      // rather than "differs by exactly one documented entry", so a future SC-04
      // addition can never again silently skip R1: adding a selector to
      // swap-selectors.ts without a decode strategy here fails this test.
      //
      // Both directions, named, so a failure says which side drifted.
      const knownNotValidated = [...KNOWN_SWAP_SELECTORS].filter((s) => !VALIDATED_SELECTORS.has(s))
      expect(knownNotValidated).toEqual([])

      const validatedNotKnown = [...VALIDATED_SELECTORS].filter((s) => !KNOWN_SWAP_SELECTORS.has(s))
      expect(validatedNotKnown).toEqual([])

      expect(VALIDATED_SELECTORS.size).toBe(KNOWN_SWAP_SELECTORS.size)
    })

    it('the selector that closed the gap is the derived AllowanceHolder exec selector', () => {
      // Pins WHICH entry restored the equality — recomputed, never typed.
      expect(VALIDATED_SELECTORS.has(ALLOWANCE_HOLDER_EXEC_SELECTOR)).toBe(true)
      expect(ALLOWANCE_HOLDER_EXEC_SELECTOR).toBe(
        toFunctionSelector('exec(address,address,uint256,address,bytes)'),
      )
    })
  })
})
