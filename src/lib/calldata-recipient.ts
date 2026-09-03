/**
 * [R1] Calldata Recipient Validation
 *
 * Extracts the recipient address from DEX swap calldata and validates it
 * matches the user's wallet address. This is a defense-in-depth measure
 * against compromised aggregator APIs that might try to redirect swap
 * output to an attacker-controlled address.
 *
 * [API-M-02] Fail-closed design: unknown selectors are blocked by default.
 * Only selectors in the VALIDATED_SELECTORS allowlist are permitted.
 * Trusted router selectors (proprietary formats where the router sends to
 * msg.sender by design) are allowed with implicitRecipient: true.
 *
 * [R1 Group G / ADR-021] 0x API v2 puts the recipient one ABI-encoded `bytes`
 * argument deep — `AllowanceHolder.exec(...)` carries the real destination
 * inside the Settler call in its `data` argument — so it gets a decode class of
 * its own that unwraps that argument. exec is a generic call primitive, so
 * Group G additionally requires its `target` and `operator` to be whitelisted
 * routers for the chain before the nested recipient means anything.
 */

import { decodeAbiParameters, toFunctionSelector, type Hex } from 'viem'
import { FEE_COLLECTOR_ADDRESS, FEE_COLLECTOR_V1_ADDRESS } from '@/lib/constants'
import { getChainConfig, DEFAULT_CHAIN_ID } from '@/lib/chains/registry'
import { isWhitelistedRouter } from '@/lib/chains/routers'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecipientCheckResult {
  valid: boolean
  extracted: string | null
  reason?: string
  implicitRecipient: boolean
}

// ---------------------------------------------------------------------------
// Constants — selectors grouped by decode strategy
// ---------------------------------------------------------------------------

/** Group A: msg.sender selectors — output goes to caller, no explicit recipient */
export const MSG_SENDER_SELECTORS = new Set([
  '0xe449022e', // 1inch uniswapV3Swap
  '0x0502b1c5', // 1inch unoswap
  '0xd9627aa4', // 0x sellToUniswap
  '0x415565b0', // 0x transformERC20
])

/**
 * Group F: trusted router selectors — proprietary calldata formats where the
 * router contract sends output to msg.sender by design. We cannot decode the
 * recipient from calldata, but trust the router's behavior.
 *
 * Trusted-by-design (msg.sender delivery, not extractable from calldata):
 *   - Odos, KyberSwap, ParaSwap
 *
 * If a source is added here, document why its router is trusted.
 */
export const TRUSTED_ROUTER_SELECTORS = new Set([
  '0x83800a8e', // Odos — swap(): proprietary encoding, router sends to msg.sender
  '0xe21fd0e9', // KyberSwap — swap(): proprietary encoding, router sends to msg.sender
  '0x3598d8ab', // ParaSwap megaSwap: proprietary encoding, router sends to msg.sender
  '0xa94e78ef', // ParaSwap multiSwap: proprietary encoding, router sends to msg.sender
  '0x46c67b6d', // ParaSwap simpleSwap: proprietary encoding, router sends to msg.sender
  '0xe3ead59e', // ParaSwap Augustus V6 swapExactAmountIn: beneficiary defaults to msg.sender (our adapter never sets it)
  // [SPRINT-9H] Augustus V6.2 single-DEX Curve methods — same trust class as
  // swapExactAmountIn (Augustus delivers to msg.sender / the receiver our
  // adapter requests; beneficiary not attacker-settable from the response).
  // Selectors verified vs the live V6.2 ABI (codeslaw + openchain + viem).
  '0x1a01c532', // swapExactAmountInOnCurveV1 (CurveV1StableNg)
  '0xe37ed256', // swapExactAmountInOnCurveV2 (Curve crypto pools)
])

/**
 * Group G — 0x API v2 AllowanceHolder.exec: the recipient lives one
 * ABI-encoded `bytes` argument deep.
 *
 * Neither selector below is typed. Both are derived at module load with viem's
 * `toFunctionSelector` from the canonical signature of the corresponding
 * function in 0x's published source, pinned at
 * `0xProject/0x-settler@1df908742d38cf407f667df6518dae6e04a01ac3` (master,
 * 2026-08-27). `calldata-recipient.test.ts` re-derives both independently and
 * cross-checks them against the SC-04 entry, so a typo cannot survive.
 *
 * `exec` — src/allowanceholder/IAllowanceHolder.sol
 *   https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/IAllowanceHolder.sol
 *   function exec(address operator, address token, uint256 amount,
 *                 address payable target, bytes calldata data)
 *
 * `execute` — src/interfaces/ISettlerTakerSubmitted.sol (struct in
 * src/interfaces/ISettlerBase.sol)
 *   https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerTakerSubmitted.sol
 *   https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerBase.sol
 *   function execute(AllowedSlippage memory slippage, bytes[] calldata actions, bytes32 zid)
 *   struct AllowedSlippage { address payable recipient; IERC20 buyToken; uint256 minAmountOut; }
 *   → ABI tuple (address,address,uint256), `recipient` is field 0. THIS is the
 *     destination of the swap output and the only thing R1 cares about.
 */
const ALLOWANCE_HOLDER_EXEC_SIGNATURE = 'exec(address,address,uint256,address,bytes)'
const SETTLER_EXECUTE_SIGNATURE = 'execute((address,address,uint256),bytes[],bytes32)'

/** [Group G] The ONLY selector 0x v2 puts in `transaction.data`. Derived, never typed. */
export const ALLOWANCE_HOLDER_EXEC_SELECTOR: string = toFunctionSelector(
  ALLOWANCE_HOLDER_EXEC_SIGNATURE,
)

/**
 * [Group G] Explicit allowlist of inner selectors reachable through `exec`.
 *
 * `exec` forwards `data` verbatim to `target` (plus 20 bytes of ERC-2771-style
 * sender suffix appended by the AllowanceHolder itself, which is NOT part of the
 * calldata we see), so the inner call can be ANY function on ANY contract. Only
 * shapes whose recipient position is known are admitted; everything else fails
 * closed.
 *
 * Deliberately holds `execute` alone:
 *   - `executeWithPermit((address,address,uint256),bytes[],bytes32,bytes)` is the
 *     other taker-submitted entry point and is also only reachable via the
 *     AllowanceHolder (`_isForwarded()`), but it requires a taker-signed permit
 *     this repo never produces — ADR-021 established there is NO signing on the
 *     swap path at all — so no TeraSwap flow can emit it.
 *   - `executeMetaTxn(...)` belongs to SettlerMetaTxn, a different flow entirely.
 * Both stay rejected; `calldata-recipient.test.ts` pins that by re-deriving their
 * selectors and asserting they are absent.
 */
export const ALLOWANCE_HOLDER_INNER_SELECTORS: ReadonlySet<string> = new Set([
  toFunctionSelector(SETTLER_EXECUTE_SIGNATURE),
])

/**
 * [API-M-02] Complete allowlist of validated selectors — union of all groups.
 * Any selector NOT in this set is blocked (fail-closed). This list can be
 * audited to understand exactly which calldata patterns are permitted.
 *
 * Validated-by-extraction (recipient decoded and checked):
 *   Group B: Uniswap V2 / Sushi routers
 *   Group C: Uniswap V3 routers
 *   Group D: 1inch (swap, unoswapTo)
 *
 * Validated-by-design (msg.sender implicit):
 *   Group A: 1inch uniswapV3Swap/unoswap, 0x sellToUniswap/transformERC20
 *   Group F: Odos, KyberSwap, ParaSwap (trusted router selectors)
 *
 * Validated-by-recursion:
 *   Group E: Uniswap multicall wrappers
 *
 * Validated-by-unwrapping (recipient decoded out of one nested `bytes` arg):
 *   Group G: 0x v2 AllowanceHolder.exec
 */
export const VALIDATED_SELECTORS: ReadonlySet<string> = new Set([
  // Group A — msg.sender implicit
  '0xe449022e', // 1inch uniswapV3Swap
  '0x0502b1c5', // 1inch unoswap
  '0xd9627aa4', // 0x sellToUniswap
  '0x415565b0', // 0x transformERC20
  // Group B — V2 router (recipient extracted)
  '0x472b43f3', // swapExactTokensForTokens (4 args)
  '0x38ed1739', // swapExactTokensForTokens (5 args, with deadline)
  '0x7ff36ab5', // swapExactETHForTokens
  '0x18cbafe5', // swapExactTokensForETH
  // Group C — V3 router (recipient extracted)
  '0x04e45aaf', // exactInputSingle
  '0xb858183f', // exactInput
  // Group D — 1inch (recipient extracted)
  '0x12aa3caf', // 1inch swap
  '0x2e95b6c8', // 1inch unoswapTo
  // Group E — Multicall wrappers (recursive validation)
  '0xac9650d8', // multicall(bytes[])
  '0x5ae401dc', // multicall(uint256,bytes[])
  // Group F — Trusted router selectors (implicit msg.sender)
  '0x83800a8e', // Odos swap
  '0xe21fd0e9', // KyberSwap swap
  '0x3598d8ab', // ParaSwap megaSwap
  '0xa94e78ef', // ParaSwap multiSwap
  '0x46c67b6d', // ParaSwap simpleSwap
  '0xe3ead59e', // ParaSwap Augustus V6 swapExactAmountIn
  // [SPRINT-9H] Augustus V6.2 single-DEX Curve methods (verified vs live ABI)
  '0x1a01c532', // swapExactAmountInOnCurveV1 (CurveV1StableNg)
  '0xe37ed256', // swapExactAmountInOnCurveV2
  // Group G — 0x v2 AllowanceHolder.exec (recipient unwrapped from inner `data`).
  // Derived above, not typed. This entry restores the R1 ≡ SC-04 equality that
  // ADR-021 had to break for one release: KNOWN_SWAP_SELECTORS and this set are
  // pinned equal again by calldata-recipient.test.ts.
  ALLOWANCE_HOLDER_EXEC_SELECTOR,
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSelector(calldata: string): string {
  return calldata.slice(0, 10).toLowerCase()
}

function stripSelector(calldata: string): Hex {
  return `0x${calldata.slice(10)}` as Hex
}

function isValidRecipient(
  extracted: string,
  expected: string,
  // [FULL-M-01] Only fee-routed swaps may legitimately deliver to the
  // FeeCollector. On direct (non-fee) routes the FeeCollector must be
  // rejected so a compromised aggregator response can't redirect output
  // there. Default true preserves backwards-compatible behaviour.
  routeViaFeeCollector: boolean = true,
  // [P225] Resolve the valid FeeCollector per chain. Default mainnet.
  chainId: number = DEFAULT_CHAIN_ID,
): boolean {
  const validAddresses = [expected.toLowerCase()]
  if (routeViaFeeCollector) {
    if (chainId === DEFAULT_CHAIN_ID) {
      // ── Mainnet — unchanged ──
      if (FEE_COLLECTOR_ADDRESS) {
        validAddresses.push(FEE_COLLECTOR_ADDRESS.toLowerCase())
      }
      // V1 is frozen but still a legitimate recipient on historical V1-targeted
      // calldata (e.g. retried order-engine submissions). Allowing it here means
      // we never spuriously fail a recipient check on inherited V1 swap data.
      validAddresses.push(FEE_COLLECTOR_V1_ADDRESS.toLowerCase())
    } else {
      // ── Other chains — resolve from the registry ──
      try {
        const cfg = getChainConfig(chainId)
        if (cfg.contracts.feeCollector) validAddresses.push(cfg.contracts.feeCollector.toLowerCase())
        if (cfg.contracts.feeCollectorV1) validAddresses.push(cfg.contracts.feeCollectorV1.toLowerCase())
      } catch {
        /* unsupported chain — only `expected` is a valid recipient */
      }
    }
  }
  return validAddresses.includes(extracted.toLowerCase())
}

// ---------------------------------------------------------------------------
// Group B — V2 router decoders
// ---------------------------------------------------------------------------

function decodeV2Recipient(selector: string, data: Hex): string {
  switch (selector) {
    // swapExactTokensForTokens(uint256,uint256,address[],address)
    case '0x472b43f3': {
      const decoded = decodeAbiParameters(
        [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
        ],
        data,
      )
      return decoded[3] as string
    }

    // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
    case '0x38ed1739': {
      const decoded = decodeAbiParameters(
        [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
        data,
      )
      return decoded[3] as string
    }

    // swapExactETHForTokens(uint256,address[],address,uint256)
    case '0x7ff36ab5': {
      const decoded = decodeAbiParameters(
        [
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
        data,
      )
      return decoded[2] as string
    }

    // swapExactTokensForETH(uint256,uint256,address[],address,uint256)
    case '0x18cbafe5': {
      const decoded = decodeAbiParameters(
        [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
        data,
      )
      return decoded[3] as string
    }

    default:
      throw new Error(`Unknown V2 selector: ${selector}`)
  }
}

// ---------------------------------------------------------------------------
// Group C — Uniswap V3 struct decoders
// ---------------------------------------------------------------------------

function decodeV3Recipient(selector: string, data: Hex): string {
  switch (selector) {
    // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
    case '0x04e45aaf': {
      const decoded = decodeAbiParameters(
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
        data,
      )
      const params = decoded[0] as {
        tokenIn: string
        tokenOut: string
        fee: number
        recipient: string
        amountIn: bigint
        amountOutMinimum: bigint
        sqrtPriceLimitX96: bigint
      }
      return params.recipient
    }

    // exactInput((bytes,address,uint256,uint256))
    case '0xb858183f': {
      const decoded = decodeAbiParameters(
        [
          {
            name: 'params',
            type: 'tuple',
            components: [
              { name: 'path', type: 'bytes' },
              { name: 'recipient', type: 'address' },
              { name: 'amountIn', type: 'uint256' },
              { name: 'amountOutMinimum', type: 'uint256' },
            ],
          },
        ],
        data,
      )
      const params = decoded[0] as {
        path: string
        recipient: string
        amountIn: bigint
        amountOutMinimum: bigint
      }
      return params.recipient
    }

    default:
      throw new Error(`Unknown V3 selector: ${selector}`)
  }
}

// ---------------------------------------------------------------------------
// Group D — 1inch decoders
// ---------------------------------------------------------------------------

function decode1inchRecipient(selector: string, data: Hex): string {
  switch (selector) {
    // swap(address,(address,address,address,address,uint256,uint256,uint256),bytes,bytes)
    case '0x12aa3caf': {
      const decoded = decodeAbiParameters(
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
        data,
      )
      // viem returns tuples with named fields
      const desc = decoded[1] as {
        srcToken: string
        dstToken: string
        srcReceiver: string
        dstReceiver: string
        amount: bigint
        minReturnAmount: bigint
        flags: bigint
      }
      return desc.dstReceiver
    }

    // unoswapTo(address,address,uint256,uint256,uint256[])
    case '0x2e95b6c8': {
      const decoded = decodeAbiParameters(
        [
          { name: 'recipient', type: 'address' },
          { name: 'srcToken', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'minReturn', type: 'uint256' },
          { name: 'pools', type: 'uint256[]' },
        ],
        data,
      )
      return decoded[0] as string
    }

    default:
      throw new Error(`Unknown 1inch selector: ${selector}`)
  }
}

// ---------------------------------------------------------------------------
// Group E — Multicall wrappers (1 level of recursion max)
// ---------------------------------------------------------------------------

function decodeMulticallRecipient(
  selector: string,
  data: Hex,
  expectedAddress: string,
  depth: number,
  routeViaFeeCollector: boolean,
  chainId: number = DEFAULT_CHAIN_ID,
): RecipientCheckResult {
  if (depth > 0) {
    // [SEC-04] Fail-closed: a nested multicall would let an adapter wrap
    // swap(...) inside multicall(multicall(swap(...))) so the inner
    // recipient is never validated. The router whitelist already blocks
    // unknown adapters, but the validator itself must not fail-open.
    console.warn(
      `[SEC-04] Nested multicall rejected at depth ${depth}; selector=${selector}`,
    )
    return {
      valid: false,
      extracted: null,
      implicitRecipient: false,
      reason: 'Nested multicall rejected — depth > 0 (fail-closed)',
    }
  }

  let innerCalls: readonly Hex[]

  switch (selector) {
    // multicall(bytes[])
    case '0xac9650d8': {
      const decoded = decodeAbiParameters(
        [{ name: 'data', type: 'bytes[]' }],
        data,
      )
      innerCalls = decoded[0] as readonly Hex[]
      break
    }

    // multicall(uint256,bytes[])
    case '0x5ae401dc': {
      const decoded = decodeAbiParameters(
        [
          { name: 'deadline', type: 'uint256' },
          { name: 'data', type: 'bytes[]' },
        ],
        data,
      )
      innerCalls = decoded[1] as readonly Hex[]
      break
    }

    default:
      throw new Error(`Unknown multicall selector: ${selector}`)
  }

  if (innerCalls.length === 0) {
    return {
      valid: true,
      extracted: null,
      implicitRecipient: false,
      reason: 'Multicall with no inner calls',
    }
  }

  // Recursively validate the first inner call only
  const firstCall = innerCalls[0] as string
  return validateCallDataRecipientInner(firstCall, expectedAddress, depth + 1, routeViaFeeCollector, chainId)
}

// ---------------------------------------------------------------------------
// Group G — 0x v2 AllowanceHolder.exec (recipient nested one `bytes` deep)
// ---------------------------------------------------------------------------

/** ABI of `exec`'s five arguments — mirrors ALLOWANCE_HOLDER_EXEC_SIGNATURE. */
const EXEC_ARG_TYPES = [
  { name: 'operator', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'target', type: 'address' },
  { name: 'data', type: 'bytes' },
] as const

/** ABI of `execute`'s three arguments — mirrors SETTLER_EXECUTE_SIGNATURE. */
const SETTLER_EXECUTE_ARG_TYPES = [
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
] as const

function execFailure(reason: string): RecipientCheckResult {
  console.warn(`[calldata-recipient] Group G blocked AllowanceHolder.exec: ${reason}`)
  return { valid: false, extracted: null, implicitRecipient: false, reason }
}

/**
 * Validate the recipient of a 0x v2 `AllowanceHolder.exec` call.
 *
 * `exec(operator, token, amount, target, data)` carries no recipient of its own.
 * It is a *generic* primitive: it grants `operator` a transaction-scoped
 * allowance over the caller's `token` and then calls `target` with `data`. An
 * `exec` whose `target`/`operator` are attacker contracts drains the taker's
 * standing approval outright, so the recipient buried in `data` is only
 * meaningful once both of those addresses are known-good. Every step below fails
 * closed; a throw anywhere is caught by validateCallDataRecipientInner's handler
 * and reported as a decode error.
 *
 * This handler is a LEAF: it never calls back into
 * validateCallDataRecipientInner, so it neither consumes nor raises the `depth`
 * budget Group E spends. An `exec` nested inside a multicall is therefore still
 * limited to Group E's single level of recursion.
 */
function decodeAllowanceHolderExecRecipient(
  data: Hex,
  expectedAddress: string,
  routeViaFeeCollector: boolean,
  chainId: number,
): RecipientCheckResult {
  const decoded = decodeAbiParameters(EXEC_ARG_TYPES, data)
  const operator = decoded[0] as string
  const target = decoded[3] as string
  const innerCalldata = decoded[4] as string

  // (1) `target` — the contract AllowanceHolder will call with `data`. An exec
  // against an arbitrary target is a transfer primitive, not a swap.
  if (!isWhitelistedRouter(target, chainId)) {
    return execFailure(
      `AllowanceHolder exec target ${target} is not a whitelisted router on chain ${chainId}`,
    )
  }

  // (2) `operator` — the address authorised to pull the taker's tokens back out
  // of the AllowanceHolder via its `transferFrom`. In every 0x v2 call observed
  // on mainnet it equals `target`; either way it must be a known router, because
  // it is the address that can actually move funds.
  if (!isWhitelistedRouter(operator, chainId)) {
    return execFailure(
      `AllowanceHolder exec operator ${operator} is not a whitelisted router on chain ${chainId}`,
    )
  }

  // (3) The inner call must carry a selector at all.
  if (!innerCalldata || innerCalldata.length < 10) {
    return execFailure('AllowanceHolder exec inner calldata is too short to contain a selector')
  }

  // (4) …and that selector must be one whose recipient position we know.
  const innerSelector = innerCalldata.slice(0, 10).toLowerCase()
  if (!ALLOWANCE_HOLDER_INNER_SELECTORS.has(innerSelector)) {
    return execFailure(
      `AllowanceHolder exec inner selector ${innerSelector} is not in the Settler allowlist`,
    )
  }

  // (5) Unwrap AllowedSlippage.recipient. A tuple mismatch throws here and is
  // caught upstream as a decode error — never silently treated as "no recipient".
  const innerDecoded = decodeAbiParameters(
    SETTLER_EXECUTE_ARG_TYPES,
    `0x${innerCalldata.slice(10)}` as Hex,
  )
  const slippage = innerDecoded[0] as {
    recipient: string
    buyToken: string
    minAmountOut: bigint
  }
  const recipient = slippage?.recipient
  if (!recipient) {
    return execFailure('AllowanceHolder exec inner execute() carries no recipient')
  }

  // (6) Same recipient rule as every other group — no separate policy.
  const valid = isValidRecipient(recipient, expectedAddress, routeViaFeeCollector, chainId)
  return {
    valid,
    extracted: recipient,
    implicitRecipient: false,
    ...(!valid && {
      reason: `Recipient ${recipient} does not match expected ${expectedAddress}`,
    }),
  }
}

// ---------------------------------------------------------------------------
// Internal recursive entry point
// ---------------------------------------------------------------------------

function validateCallDataRecipientInner(
  calldata: string,
  expectedAddress: string,
  depth: number,
  routeViaFeeCollector: boolean,
  chainId: number = DEFAULT_CHAIN_ID,
): RecipientCheckResult {
  try {
    if (!calldata || calldata.length < 10) {
      return {
        valid: false,
        extracted: null,
        implicitRecipient: false,
        reason: 'Calldata too short to contain a valid selector',
      }
    }

    const selector = getSelector(calldata)
    const data = stripSelector(calldata)

    // Group A — msg.sender implicit recipient
    if (MSG_SENDER_SELECTORS.has(selector)) {
      return { valid: true, extracted: null, implicitRecipient: true }
    }

    // Group F — trusted router selectors (proprietary, msg.sender by design)
    if (TRUSTED_ROUTER_SELECTORS.has(selector)) {
      return { valid: true, extracted: null, implicitRecipient: true }
    }

    // Group B — V2 routers
    const V2_SELECTORS = ['0x472b43f3', '0x38ed1739', '0x7ff36ab5', '0x18cbafe5']
    if (V2_SELECTORS.includes(selector)) {
      const recipient = decodeV2Recipient(selector, data)
      return {
        valid: isValidRecipient(recipient, expectedAddress, routeViaFeeCollector, chainId),
        extracted: recipient,
        implicitRecipient: false,
        ...(!isValidRecipient(recipient, expectedAddress, routeViaFeeCollector, chainId) && {
          reason: `Recipient ${recipient} does not match expected ${expectedAddress}`,
        }),
      }
    }

    // Group C — Uniswap V3 structs
    const V3_SELECTORS = ['0x04e45aaf', '0xb858183f']
    if (V3_SELECTORS.includes(selector)) {
      const recipient = decodeV3Recipient(selector, data)
      return {
        valid: isValidRecipient(recipient, expectedAddress, routeViaFeeCollector, chainId),
        extracted: recipient,
        implicitRecipient: false,
        ...(!isValidRecipient(recipient, expectedAddress, routeViaFeeCollector, chainId) && {
          reason: `Recipient ${recipient} does not match expected ${expectedAddress}`,
        }),
      }
    }

    // Group D — 1inch
    const ONEINCH_SELECTORS = ['0x12aa3caf', '0x2e95b6c8']
    if (ONEINCH_SELECTORS.includes(selector)) {
      const recipient = decode1inchRecipient(selector, data)
      return {
        valid: isValidRecipient(recipient, expectedAddress, routeViaFeeCollector, chainId),
        extracted: recipient,
        implicitRecipient: false,
        ...(!isValidRecipient(recipient, expectedAddress, routeViaFeeCollector, chainId) && {
          reason: `Recipient ${recipient} does not match expected ${expectedAddress}`,
        }),
      }
    }

    // Group E — Multicall wrappers
    const MULTICALL_SELECTORS = ['0xac9650d8', '0x5ae401dc']
    if (MULTICALL_SELECTORS.includes(selector)) {
      return decodeMulticallRecipient(selector, data, expectedAddress, depth, routeViaFeeCollector, chainId)
    }

    // Group G — 0x v2 AllowanceHolder.exec (recipient inside the `data` arg)
    if (selector === ALLOWANCE_HOLDER_EXEC_SELECTOR) {
      return decodeAllowanceHolderExecRecipient(data, expectedAddress, routeViaFeeCollector, chainId)
    }

    // [API-M-02] Unknown selector — fail closed
    console.warn(`[calldata-recipient] Blocked unknown selector ${selector} — add to VALIDATED_SELECTORS if legitimate`)
    return {
      valid: false,
      extracted: null,
      implicitRecipient: false,
      reason: `Unknown selector ${selector} — not in validated allowlist`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Decode error on a known selector = code bug, not attack. Fail closed
    // to prevent malformed calldata from bypassing validation.
    console.error(`[calldata-recipient] Decode error (blocked): ${message}`)
    return {
      valid: false,
      extracted: null,
      implicitRecipient: false,
      reason: `Decode error: ${message}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateCallDataRecipient(
  calldata: string,
  expectedAddress: string,
  // [FULL-M-01] Default true preserves existing behaviour for callers that
  // haven't been updated; direct-route callers pass false to reject the
  // FeeCollector as a valid recipient.
  routeViaFeeCollector: boolean = true,
  // [P225] Target chain — resolves the per-chain FeeCollector in the valid set. Default mainnet.
  chainId: number = DEFAULT_CHAIN_ID,
): RecipientCheckResult {
  return validateCallDataRecipientInner(calldata, expectedAddress, 0, routeViaFeeCollector, chainId)
}
