// @vitest-environment node
/**
 * [ADR-021] 0x API v2 execution path — end-to-end gate coverage.
 *
 * Production, 2026-09-03 12:35–12:36 UTC: 0x quoted ETH→USDC on mainnet
 * (1 ETH = 2407.45 USDC via PancakeSwap_V3) and every execution attempt was
 * rejected by the server-side selector gate:
 *   [SC-04] Rejected unknown swap selector: 0x2213bc0b source: 0x   (x2)
 *   [SC-04] Rejected unknown swap selector: 0x1fff991f source: 0x   (x1)
 *
 * SPRINT-9E migrated the QUOTE path to 0x API v2 but left mainnet's execution
 * gates describing v1: KNOWN_SWAP_SELECTORS held only the Exchange Proxy v1
 * selectors, and the mainnet router entry was the v1 Exchange Proxy. ADR-021
 * moves mainnet onto the allowance-holder endpoint family (as 8453/42161 already
 * were) and widens both gates by exactly the one selector + one address that
 * flow needs.
 *
 * These tests pin the THREE things that must agree for a 0x swap to execute:
 *   (1) the endpoint the adapter calls,
 *   (2) the `transaction.to` that endpoint returns,
 *   (3) the whitelist/spender entries that address must satisfy.
 * If any one drifts, exactly one of these fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { toFunctionSelector } from 'viem'
import zerox, { ZEROX_V2_QUOTE_PATH, ZEROX_V2_PRICE_PATH } from './zerox'
import { ZEROX_ALLOWANCE_HOLDER } from '@/lib/constants'
import { ROUTER_WHITELIST_BY_CHAIN, getRouterWhitelist } from '@/lib/chains/routers'
import { validateRouterAddress, fetchApproveSpender } from '@/lib/api'
import { isKnownSwapSelector } from '@/lib/swap-selectors'
import { validateCallDataRecipient } from '@/lib/calldata-recipient'

const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const FROM = '0x1111111111111111111111111111111111111111'

/**
 * A stand-in for whatever Settler version 0x currently ships. Its exact identity
 * is deliberately irrelevant — that IS the finding: the permit2 endpoint's
 * `transaction.to` rotates with each Settler release (V1.9, V1.10, … observed
 * on-chain), so no fixed value can be whitelisted. All that matters here is that
 * it is not the AllowanceHolder.
 */
const ROTATING_SETTLER_STANDIN = `0x${'ab'.repeat(20)}`

const EXEC_SELECTOR = toFunctionSelector('exec(address,address,uint256,address,bytes)')
const EXEC_CALLDATA = `${EXEC_SELECTOR}${'0'.repeat(128)}`

let calls: string[]

beforeEach(() => {
  calls = []
  process.env.ZEROX_API_KEY = 'test-0x-key'
  vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const [url] = args as [string]
    calls.push(url)
    // Model BOTH endpoint families' real behaviour: permit2 hands back a rotating
    // Settler, allowance-holder hands back the fixed AllowanceHolder. This is what
    // makes the acceptance-3 assertion break if the adapter is ever pointed back at
    // permit2 — the returned tx.to stops matching the whitelisted router entry.
    const to = url.includes('/swap/permit2/')
      ? ROTATING_SETTLER_STANDIN
      : ZEROX_ALLOWANCE_HOLDER
    return new Response(
      JSON.stringify({
        buyAmount: '2407450000',
        transaction: { to, data: EXEC_CALLDATA, value: '0', gas: 210000 },
        route: { fills: [{ source: 'PancakeSwap_V3' }] },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })
})
afterEach(() => vi.restoreAllMocks())

describe('[ADR-021] mainnet 0x uses the allowance-holder endpoint family', () => {
  it('fetchSwapData on mainnet hits /swap/allowance-holder/quote, never permit2', async () => {
    await zerox.fetchSwapData({
      src: WETH_MAINNET, dst: USDC_MAINNET, amount: '1000000000000000000',
      from: FROM, slippage: 0.5, chainId: 1,
    })
    expect(calls[0]).toContain(ZEROX_V2_QUOTE_PATH)
    expect(calls[0]).not.toContain('/swap/permit2/')
  })

  it('fetchQuote on mainnet hits /swap/allowance-holder/price, never permit2', async () => {
    await zerox.fetchQuote({
      src: WETH_MAINNET, dst: USDC_MAINNET, amount: '1000000000000000000', chainId: 1,
    })
    expect(calls[0]).toContain(ZEROX_V2_PRICE_PATH)
    expect(calls[0]).not.toContain('/swap/permit2/')
  })

  it('every chain now uses the same endpoint family — no per-chain split left', async () => {
    for (const chainId of [1, 8453, 42161]) {
      calls = []
      await zerox.fetchSwapData({
        src: WETH_MAINNET, dst: USDC_MAINNET, amount: '1000000000000000000',
        from: FROM, slippage: 0.5, chainId,
      })
      expect(calls[0]).toContain('/swap/allowance-holder/quote')
    }
  })
})

describe('[ADR-021] acceptance 3 — the mainnet router entry IS the adapter\'s tx.to', () => {
  it('ROUTER_WHITELIST_BY_CHAIN[1][\'0x\'] equals the tx.to the chosen endpoint returns', async () => {
    const r = await zerox.fetchSwapData({
      src: WETH_MAINNET, dst: USDC_MAINNET, amount: '1000000000000000000',
      from: FROM, slippage: 0.5, chainId: 1,
    })
    // Pinned both ways: if the adapter reverts to the permit2 family, the mock
    // returns the rotating Settler and this fails; if the whitelist entry is
    // changed without changing the adapter, it fails too.
    expect(r?.tx?.to?.toLowerCase()).toBe(ROUTER_WHITELIST_BY_CHAIN[1]['0x'].toLowerCase())
    expect(r?.tx?.to?.toLowerCase()).toBe(ZEROX_ALLOWANCE_HOLDER.toLowerCase())
    expect(r?.tx?.to?.toLowerCase()).not.toBe(ROTATING_SETTLER_STANDIN.toLowerCase())
  })

  it('a rotating Settler tx.to is NOT accepted by the mainnet router gate', () => {
    // The counterfactual for keeping permit2: whatever Settler 0x ships today is
    // not whitelisted, and cannot be, because the next release changes it.
    expect(validateRouterAddress(ROTATING_SETTLER_STANDIN, '0x', 1).valid).toBe(false)
  })

  it('the AllowanceHolder passes the mainnet router gate and is a trusted spender', async () => {
    expect(validateRouterAddress(ZEROX_ALLOWANCE_HOLDER, '0x', 1).valid).toBe(true)
    expect(getRouterWhitelist(1)).toContain(ZEROX_ALLOWANCE_HOLDER.toLowerCase())
    // The allowance-holder flow pulls the taker's ERC-20 via AllowanceHolder
    // .transferFrom, so the approval spender is the AllowanceHolder, not Permit2.
    expect((await fetchApproveSpender('0x', 1)).toLowerCase())
      .toBe(ZEROX_ALLOWANCE_HOLDER.toLowerCase())
  })

  it('the AllowanceHolder constant matches the Base + Arbitrum literals (one address, three chains)', () => {
    // Those two entries are untouched by this change; this pins the constant
    // against them so the mainnet entry can never silently diverge.
    expect(ROUTER_WHITELIST_BY_CHAIN[8453]['0x'].toLowerCase())
      .toBe(ZEROX_ALLOWANCE_HOLDER.toLowerCase())
    expect(ROUTER_WHITELIST_BY_CHAIN[42161]['0x'].toLowerCase())
      .toBe(ZEROX_ALLOWANCE_HOLDER.toLowerCase())
  })

  it('the v1 Exchange Proxy stays whitelisted (rule #4 — retained, not removed)', () => {
    expect(validateRouterAddress('0xDef1C0ded9bec7F1a1670819833240f027b25EfF', '0x', 1).valid)
      .toBe(true)
  })
})

describe('[ADR-021] the SC-04 gate now passes the calldata 0x v2 actually produces', () => {
  it('accepts the exec calldata the adapter returns on mainnet', async () => {
    const r = await zerox.fetchSwapData({
      src: WETH_MAINNET, dst: USDC_MAINNET, amount: '1000000000000000000',
      from: FROM, slippage: 0.5, chainId: 1,
    })
    // The exact check /api/swap runs before returning the tx to the wallet.
    expect(isKnownSwapSelector(r!.tx!.data as string)).toBe(true)
  })
})

describe('[R1 Group G] the recipient gate now DECODES exec instead of rejecting the selector', () => {
  it('exec is no longer rejected as an unknown selector', () => {
    // ADR-021 shipped with this pinned as an open gap: exec sat outside
    // VALIDATED_SELECTORS, so R1 rejected it on the selector alone. Group G
    // replaced that with a real nested decode. Whatever R1 says about exec now,
    // it must NOT be "unknown selector".
    const result = validateCallDataRecipient(EXEC_CALLDATA, FROM, false, 1)
    expect(result.reason ?? '').not.toContain('not in validated allowlist')
  })

  it('EXEC_CALLDATA above is a placeholder, not real exec args — it still fails closed', () => {
    // 64 zero bytes cannot decode as (address,address,uint256,address,bytes); the
    // decode throws and R1 blocks. Recorded so the assertion above is never read
    // as "this synthetic calldata would execute".
    const result = validateCallDataRecipient(EXEC_CALLDATA, FROM, false, 1)
    expect(result.valid).toBe(false)
    expect(result.implicitRecipient).toBe(false)
  })

  it('[ADR-023] EXECUTABLE END-TO-END: exec\'s target is checked against 0x\'s registry, not the whitelist', () => {
    // The last gate. Group G used to validate exec's `target` against the
    // per-chain router whitelist; 0x's real target is the Settler, which
    // ADR-021 established ROTATES with each release and therefore can never be
    // a whitelist entry — so 0x was executable on zero chains by construction.
    //
    // ADR-023 replaced that check with a use-time read of 0x's deployer/registry
    // (ownerOf(2) OR prev(2)). Two things must both stay true:
    //
    //  1. The rotating Settler is STILL not in the router whitelist — the fix
    //     was not to widen the whitelist, and this pins that it was not.
    expect(getRouterWhitelist(1)).not.toContain(ROTATING_SETTLER_STANDIN.toLowerCase())

    //  2. `tx.to` — the address the wallet actually calls — is the
    //     AllowanceHolder, which IS whitelisted and does NOT rotate. That is
    //     the only address the outer router gate ever sees.
    expect(getRouterWhitelist(1)).toContain(ZEROX_ALLOWANCE_HOLDER.toLowerCase())

    // The identity check itself, with real per-chain calldata and real registry
    // answers, lives in calldata-recipient.test.ts ([ADR-023] golden vectors).
  })
})
