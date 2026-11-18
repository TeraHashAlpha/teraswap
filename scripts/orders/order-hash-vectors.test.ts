// @vitest-environment node
/**
 * [fix/orders-server-side-order-hash] The TypeScript half of the server-vs-contract order-hash
 * differential (the Solidity half is contracts/order-engine/test/OrderHashDifferential.t.sol).
 *
 *  1. The committed OrderHashVectors.sol is exactly what the server function renders now, so the
 *     constants the contracts are compared against cannot drift from computeOrderHash.
 *  2. The vectors cover what the goal names: >= 200 v3 orders, Base and Arbitrum, all three order
 *     types, DCA with dcaTotal 1 and 365.
 *  3. A second TS oracle, written the way the contracts write getOrderHash (keccak256(abi.encode(
 *     TYPEHASH, fields...)) with the type string read from the .sol source), agrees on every vector.
 *  4. The vector domains are the ones the route recovers under (getOrderExecutorDomain /
 *     getOrderExecutorV3Domain), so the digest half of the differential checks the real domain.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem'
import { VECTOR_SETS, vectorsFor, vectorDomain, renderVectorsSolidity, type VectorSet } from './order-hash-vectors'

const ROOT = resolve(__dirname, '../..')
const SOL_VECTORS = resolve(ROOT, 'contracts/order-engine/test/OrderHashVectors.sol')

/** The ORDER_TYPEHASH string literal of a contract, read from its source (the .sol is the authority). */
function contractTypeString(file: string): string {
  const src = readFileSync(resolve(ROOT, 'contracts/order-engine', file), 'utf8')
  const m = src.match(/ORDER_TYPEHASH\s*=\s*keccak256\(\s*((?:"[^"]*"\s*)+)\)/)
  if (!m) throw new Error(`ORDER_TYPEHASH not found in ${file}`)
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join('')
}

/** keccak256(abi.encode(ORDER_TYPEHASH, fields...)) — the contracts' own construction, field by field. */
function contractStyleHash(version: 2 | 3, typeString: string, m: Record<string, unknown>): Hex {
  const n = (k: string) => BigInt(m[k] as string | number)
  const a = (k: string) => m[k] as `0x${string}`
  const head = [
    { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
    { type: 'uint256' }, { type: 'uint256' },
  ] as const
  const tail = [
    { type: 'uint8' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' },
  ] as const
  const headValues = [keccak256(toBytes(typeString)), a('owner'), a('tokenIn'), a('tokenOut'), n('amountIn'), n('minAmountOut')] as const
  const tailValues = [
    Number(m.orderType), Number(m.condition), n('targetPrice'), a('priceFeed'), n('expiry'),
    n('nonce'), a('router'), m.routerDataHash as Hex, n('dcaInterval'), n('dcaTotal'),
  ] as const
  if (version === 3) {
    return keccak256(encodeAbiParameters(
      [...head, { type: 'uint16' }, ...tail],
      [...headValues, Number(m.maxSlippageBps), ...tailValues],
    ))
  }
  return keccak256(encodeAbiParameters([...head, ...tail], [...headValues, ...tailValues]))
}

describe('OrderHashVectors.sol is the server function output (drift guard)', () => {
  it('the committed file equals what scripts/orders/gen-order-hash-vectors.ts renders now', () => {
    expect(readFileSync(SOL_VECTORS, 'utf8')).toBe(renderVectorsSolidity())
  })
})

describe('vector coverage', () => {
  const v3 = VECTOR_SETS.filter((s) => s.version === 3)

  it('>= 200 v3 orders, on Base (8453) and Arbitrum One (42161)', () => {
    expect(v3.reduce((n, s) => n + s.count, 0)).toBeGreaterThanOrEqual(200)
    expect(v3.map((s) => s.chainId).sort((x, y) => x - y)).toEqual([8453, 42161])
  })

  it.each(VECTOR_SETS.map((s) => [s.key, s] as const))('%s: all three order types; DCA has dcaTotal 1 and 365', (_k, set) => {
    const messages = vectorsFor(set).map((v) => v.message)
    expect(new Set(messages.map((m) => m.orderType))).toEqual(new Set([0, 1, 2]))
    const dcaTotals = new Set(messages.filter((m) => m.orderType === 2).map((m) => m.dcaTotal))
    expect(dcaTotals.has('1')).toBe(true)
    expect(dcaTotals.has('365')).toBe(true)
  })

  it('the 352 orders are pairwise distinct (no seed collision between sets)', () => {
    const all = VECTOR_SETS.flatMap((s) => vectorsFor(s).map((v) => v.structHash))
    expect(all).toHaveLength(352)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('second oracle: the contracts\' own abi.encode construction', () => {
  const typeStrings = {
    3: contractTypeString('TeraSwapOrderExecutorV3.sol'),
    2: contractTypeString('TeraSwapOrderExecutor.sol'),
  } as const

  it('reads both ORDER_TYPEHASH strings from the .sol sources', () => {
    expect(typeStrings[3]).toContain('uint16 maxSlippageBps')
    expect(typeStrings[2]).not.toContain('maxSlippageBps')
  })

  it.each(VECTOR_SETS.map((s) => [s.key, s] as const))('%s: computeOrderHash == keccak256(abi.encode(TYPEHASH, ...)) on every order', (_k, set) => {
    for (const v of vectorsFor(set)) {
      expect(v.structHash).toBe(contractStyleHash(set.version, typeStrings[set.version], v.message))
    }
  })
})

describe('vector domains are the domains the route recovers under', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it.each(VECTOR_SETS.map((s) => [s.key, s] as const))('%s', async (_k, set: VectorSet) => {
    // config.ts reads NEXT_PUBLIC_* at module load; stub the production address, then load it fresh.
    // (Stubs only: no real environment value is read.)
    if (set.version === 3) {
      vi.stubEnv(set.chainId === 8453 ? 'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE' : 'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM', set.executor)
    } else if (set.chainId === 1) {
      vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS', set.executor)
    }
    vi.resetModules()
    const config = await import('@/lib/order-engine/config')
    const routeDomain = set.version === 3 ? config.getOrderExecutorV3Domain(set.chainId) : config.getOrderExecutorDomain(set.chainId)
    expect(routeDomain).toEqual(vectorDomain(set))
  })
})
