// @vitest-environment node
/**
 * CurveRouterNG's get_dy/_exchange require a `pool_type` selector at
 * `_swap_params[..][3]` (1 = legacy stable, 10 = stable-ng, 2/3 = crypto/
 * tricrypto-ng, 20/30 = crypto-ng, 4 = llamma). curve.ts previously hardcoded
 * that slot to `0n` for every pool, which reverts CurveRouterNG's get_dy for
 * pools where 0 doesn't match any real pool_type (reproduced on mainnet for
 * 3pool — see scripts/verify-curve-pool-types.mjs).
 *
 * These tests pin the on-chain-proven `poolType` per pool and assert it lands
 * in the right row/slot of the encoded `_swap_params`.
 */
import { describe, it, expect } from 'vitest'
import { keccak256, toBytes } from 'viem'
import { buildCurveRoute, CURVE_POOLS, CURVE_ROUTER_ABI } from './curve'

describe('CURVE_POOLS poolType — proven on-chain per scripts/verify-curve-pool-types.mjs', () => {
  it('3pool: poolType is 1 (legacy stable, proven both directions DAI<->USDC)', () => {
    expect(CURVE_POOLS['3pool'].poolType).toBe(1)
  })

  it('steth: poolType is 1 (legacy stable, proven both directions ETH<->stETH)', () => {
    expect(CURVE_POOLS.steth.poolType).toBe(1)
  })

  it('fraxusdc: poolType is 1 (legacy stable, proven both directions FRAX<->USDC)', () => {
    expect(CURVE_POOLS.fraxusdc.poolType).toBe(1)
  })

  it('excludes pools whose poolType could not be proven on-chain', () => {
    expect(CURVE_POOLS.tricrypto2).toBeUndefined()
    expect(CURVE_POOLS.crvusdusdc).toBeUndefined()
    expect(CURVE_POOLS.crvusdusdt).toBeUndefined()
  })
})

describe('buildCurveRoute encodes poolType into _swap_params[0][3]', () => {
  it('3pool DAI->USDC: slot [3] of the active row is the proven poolType (1n), not 0n', () => {
    const { pool, coins, swapType, poolType } = CURVE_POOLS['3pool']
    const { swapParams } = buildCurveRoute(
      coins[0], coins[1], pool, 0, 1, swapType, poolType,
    )
    expect(swapParams[0][3]).toBe(1n)
  })

  it('steth ETH->stETH: slot [3] of the active row is the proven poolType (1n)', () => {
    const { pool, coins, swapType, poolType } = CURVE_POOLS.steth
    const { swapParams } = buildCurveRoute(
      coins[0], coins[1], pool, 0, 1, swapType, poolType,
    )
    expect(swapParams[0][3]).toBe(1n)
  })

  it('fraxusdc FRAX->USDC: slot [3] of the active row is the proven poolType (1n)', () => {
    const { pool, coins, swapType, poolType } = CURVE_POOLS.fraxusdc
    const { swapParams } = buildCurveRoute(
      coins[0], coins[1], pool, 0, 1, swapType, poolType,
    )
    expect(swapParams[0][3]).toBe(1n)
  })

  it('negative control: 3pool slot [3] is no longer hardcoded 0n (fails on origin/main)', () => {
    const { pool, coins, swapType, poolType } = CURVE_POOLS['3pool']
    const { swapParams } = buildCurveRoute(
      coins[0], coins[1], pool, 0, 1, swapType, poolType,
    )
    expect(swapParams[0][3]).not.toBe(0n)
  })

  it('untouched rows/slots stay zero — only the active row/slot[3] changes', () => {
    const { pool, coins, swapType, poolType } = CURVE_POOLS['3pool']
    const { swapParams } = buildCurveRoute(
      coins[0], coins[1], pool, 0, 1, swapType, poolType,
    )
    expect(swapParams[0][0]).toBe(0n) // i
    expect(swapParams[0][1]).toBe(1n) // j
    expect(swapParams[0][2]).toBe(BigInt(swapType))
    expect(swapParams[0][4]).toBe(0n) // n_coins slot untouched
    for (const row of swapParams.slice(1)) {
      expect(row).toEqual([0n, 0n, 0n, 0n, 0n])
    }
  })
})

describe('get_dy selector is unchanged (5-arg uint256[5][5] ABI)', () => {
  it('keccak256("get_dy(address[11],uint256[5][5],uint256,address[5])") first 4 bytes == the ABI-encoded selector', () => {
    const getDy = CURVE_ROUTER_ABI.find(f => f.name === 'get_dy')
    if (!getDy) throw new Error('get_dy not found in CURVE_ROUTER_ABI')

    const signature = `get_dy(${getDy.inputs.map(i => i.type).join(',')})`
    const computedSelector = keccak256(toBytes(signature)).slice(0, 10)

    expect(signature).toBe('get_dy(address[11],uint256[5][5],uint256,address[5])')
    expect(computedSelector).toBe('0x637653cb')
  })
})
