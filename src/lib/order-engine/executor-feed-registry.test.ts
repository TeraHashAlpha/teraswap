/**
 * [FIX-DCA-NOFEED-FAIL-CLOSED] `readExecutorFeedCoverage` — the executor's own `tokenUsdFeeds`
 * registry as the sole answer to "will the on-chain floor be max(oracleFloor, scaledMin), or bare
 * scaledMin?".
 *
 * The tuple fixtures are the REAL answers read from the Base (8453) OrderExecutorV3
 * `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` on 2026-09-09:
 *
 *   cast call <executor> "tokenUsdFeeds(address)(address,uint8,uint8,uint256,bool)" <token>
 *     WETH  0x4200…0006 → 0x71041ddd…Bb70, 8, 18, 3600,  true
 *     USDC  0x8335…2913 → 0x458138Fc…9061, 8,  6, 90000, true
 *     ETHFI 0xFe0c…C0eB → 0x0000…0000,     0,  0, 0,     false
 *
 * so the decode under test is pinned to a shape that was observed, not one that was assumed.
 */

import { describe, it, expect, vi } from 'vitest'
import { readExecutorFeedCoverage, EXECUTOR_FEED_REGISTRY_FN, type ExecutorFeedLeg } from './executor-feed-registry'

const EXECUTOR = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ETHFI = '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB'

const REGISTERED_WETH = ['0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 8, 18, 3600n, true] as const
const REGISTERED_USDC = ['0x458138Fc0D67027E9A6778ef40a6ffC318c69061', 8, 6, 90000n, true] as const
const ZERO_STRUCT = ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false] as const

const TABLE: Record<string, readonly unknown[]> = {
  [WETH.toLowerCase()]: REGISTERED_WETH,
  [USDC.toLowerCase()]: REGISTERED_USDC,
  [ETHFI.toLowerCase()]: ZERO_STRUCT,
}

function reader(overrides: Record<string, unknown> = {}) {
  return {
    readContract: vi.fn(async (args: { args: readonly unknown[] }) => {
      const key = String(args.args[0]).toLowerCase()
      return key in overrides ? overrides[key] : (TABLE[key] ?? ZERO_STRUCT)
    }),
  }
}

const spend = (symbol: string, address: string): ExecutorFeedLeg => ({ role: 'spend', symbol, address })
const buy = (symbol: string, address: string): ExecutorFeedLeg => ({ role: 'buy', symbol, address })

const base = { executor: EXECUTOR, chainName: 'Base' }

describe('readExecutorFeedCoverage — both legs registered', () => {
  it('passes WETH → USDC on Base, the pair the executor really does price', async () => {
    const result = await readExecutorFeedCoverage({
      ...base, reader: reader(), legs: [spend('WETH', WETH), buy('USDC', USDC)],
    })
    expect(result).toEqual({ ok: true, unregistered: [], unreadable: false, reason: null })
  })

  it('asks the executor — the right address, the right function, once per leg', async () => {
    const r = reader()
    await readExecutorFeedCoverage({
      ...base, reader: r, legs: [spend('WETH', WETH), buy('USDC', USDC)],
    })
    expect(r.readContract).toHaveBeenCalledTimes(2)
    for (const call of r.readContract.mock.calls) {
      const args = call[0] as unknown as { address: string; functionName: string }
      expect(args.address).toBe(EXECUTOR)
      expect(args.functionName).toBe(EXECUTOR_FEED_REGISTRY_FN)
    }
    expect(EXECUTOR_FEED_REGISTRY_FN).toBe('tokenUsdFeeds')
  })
})

describe('readExecutorFeedCoverage — an unregistered leg blocks and is named', () => {
  it('blocks WETH → ETHFI and names the BUY leg, not the pair in general', async () => {
    const result = await readExecutorFeedCoverage({
      ...base, reader: reader(), legs: [spend('WETH', WETH), buy('ETHFI', ETHFI)],
    })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toBe(false)
    expect(result.unregistered.map(l => l.symbol)).toEqual(['ETHFI'])
    expect(result.reason).toMatch(/ETHFI \(the token you're buying\)/)
    expect(result.reason).toMatch(/Base/)
  })

  it('blocks on the SPEND leg too — _fairValueOut needs both, so either poisons it', async () => {
    const result = await readExecutorFeedCoverage({
      ...base, reader: reader(), legs: [spend('ETHFI', ETHFI), buy('USDC', USDC)],
    })
    expect(result.ok).toBe(false)
    expect(result.unregistered.map(l => l.symbol)).toEqual(['ETHFI'])
    expect(result.reason).toMatch(/ETHFI \(the token you're spending\)/)
  })

  it('names both when neither is registered', async () => {
    const result = await readExecutorFeedCoverage({
      ...base, reader: reader(), legs: [spend('AAA', ETHFI), buy('BBB', '0x' + '11'.repeat(20))],
    })
    expect(result.unregistered).toHaveLength(2)
    expect(result.reason).toMatch(/AAA .* and BBB /)
    expect(result.reason).toMatch(/these tokens/)
  })

  it('makes no protection promise in the copy it replaces the consent modal with', async () => {
    const result = await readExecutorFeedCoverage({
      ...base, reader: reader(), legs: [spend('WETH', WETH), buy('ETHFI', ETHFI)],
    })
    // The superseded modal said "so you're not unprotected". With hasFeed=false the floor is the
    // ADR-013 dust fallback, so nothing in this flow may claim protection of any kind.
    expect(result.reason).not.toMatch(/not unprotected/i)
    expect(result.reason).not.toMatch(/protected/i)
    expect(result.reason).not.toMatch(/safe/i)
  })
})

describe('readExecutorFeedCoverage — fails CLOSED on anything it cannot establish', () => {
  it('a throwing reader blocks (RPC down) and says so, without blaming the token', async () => {
    const result = await readExecutorFeedCoverage({
      ...base,
      reader: { readContract: vi.fn(async () => { throw new Error('fetch failed') }) },
      legs: [spend('WETH', WETH), buy('USDC', USDC)],
    })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toBe(true)
    expect(result.unregistered).toEqual([])
    expect(result.reason).toMatch(/could not check/i)
    // "We could not check" must never be told as "this token has no price source".
    expect(result.reason).not.toMatch(/has no registered price source/i)
  })

  it('a null executor blocks — no contract to ask means no oracle floor either', async () => {
    const r = reader()
    const result = await readExecutorFeedCoverage({
      reader: r, executor: null, chainName: 'Base', legs: [spend('WETH', WETH), buy('USDC', USDC)],
    })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toBe(true)
    expect(r.readContract).not.toHaveBeenCalled()
  })

  it('no legs blocks — an empty check is not a passed check', async () => {
    const result = await readExecutorFeedCoverage({ ...base, reader: reader(), legs: [] })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toBe(true)
  })

  it('an answer whose SHAPE is unrecognised blocks — not silently read as "no"', async () => {
    // A viem change that returned something other than a positional tuple must surface as
    // "could not check", never as a confident false. `unreadable` is what distinguishes them.
    const result = await readExecutorFeedCoverage({
      ...base,
      reader: reader({ [USDC.toLowerCase()]: 'something-else' }),
      legs: [spend('WETH', WETH), buy('USDC', USDC)],
    })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toBe(true)
  })

  it('a tuple whose registered slot is not a boolean blocks', async () => {
    const result = await readExecutorFeedCoverage({
      ...base,
      reader: reader({ [USDC.toLowerCase()]: [USDC, 8, 6, 90000n, 1] }),
      legs: [spend('WETH', WETH), buy('USDC', USDC)],
    })
    expect(result.unreadable).toBe(true)
  })
})

describe('readExecutorFeedCoverage — decode', () => {
  it('accepts a named-object decode as well as a positional tuple', async () => {
    // Belt and braces against a viem upgrade: an object keyed by output name must not be read as
    // "not registered" simply because it is not an array.
    const result = await readExecutorFeedCoverage({
      ...base,
      reader: reader({
        [USDC.toLowerCase()]: { feed: USDC, feedDecimals: 8, tokenDecimals: 6, maxStaleness: 90000n, registered: true },
      }),
      legs: [spend('WETH', WETH), buy('USDC', USDC)],
    })
    expect(result.ok).toBe(true)
  })

  it('reads the registered flag, not the feed address — a zero feed with registered:true is registered', async () => {
    // The contract's own gate is `if (!cfg.registered) return (0, 0, false)` (_readFeedUsd), so
    // `registered` is the bit that matters and inferring it from the address would drift.
    const result = await readExecutorFeedCoverage({
      ...base,
      reader: reader({ [USDC.toLowerCase()]: ['0x' + '00'.repeat(20), 8, 6, 90000n, true] }),
      legs: [buy('USDC', USDC)],
    })
    expect(result.ok).toBe(true)
  })
})
