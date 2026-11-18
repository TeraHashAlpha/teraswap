/**
 * [fix/orders-server-side-order-hash] Seeded order vectors for the server-vs-contract order-hash
 * differential.
 *
 * Both sides derive the SAME orders from (seed, index) with keccak256(abi.encode(seed, i, k)):
 *   - this file, then the server's computeOrderHash / computeOrderDigest give the expected hashes,
 *     which renderVectorsSolidity() writes into contracts/order-engine/test/OrderHashVectors.sol;
 *   - OrderHashDifferential.t.sol rebuilds each order in Solidity from the same (seed, i) and calls the
 *     executor's OWN getOrderHash(order) and domainSeparator(), then compares with those constants.
 * order-hash-vectors.test.ts fails when the committed .sol is not exactly what this file renders now,
 * so the constants cannot drift from the server function. Regenerate with:
 *   node --no-warnings scripts/orders/gen-order-hash-vectors.ts
 *
 * The forge suite runs without ffi or fs permissions (CI: `forge test -vvv`), hence constants in a
 * generated source file rather than a JSON fixture read at test time.
 *
 * Field derivation (MUST match OrderHashDifferential.t.sol _order()): w(k) = word(seed, i, k);
 * mag(x) = x >> (x % 256) spreads magnitudes from 0 to 2^256-1; addresses are the low 160 bits.
 */
import { encodeAbiParameters, getAddress, keccak256, zeroAddress, zeroHash, type Hex } from 'viem'
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
import { computeOrderDigest, computeOrderHash } from '../../src/lib/order-engine/order-hash.ts'
// @ts-expect-error TS5097 - same
import { ORDER_EIP712_TYPES, ORDER_V3_EIP712_TYPES } from '../../src/lib/order-engine/order-eip712-types.ts'

export interface VectorSet {
  /** Solidity constant prefix, e.g. V3_BASE → V3_BASE_SEED / _COUNT / _STRUCT / _DIGEST. */
  key: string
  version: 2 | 3
  chainId: number
  /** The executor's production address on that chain (docs/DEPLOYMENTS.md), used as verifyingContract. */
  executor: `0x${string}`
  seed: bigint
  count: number
}

export const VECTOR_SETS: readonly VectorSet[] = [
  // OrderExecutor V3 · Base (8453) — docs/DEPLOYMENTS.md "OrderExecutor V3 · Base".
  { key: 'V3_BASE', version: 3, chainId: 8453, executor: '0x686b4f812291F4De238E59ED00BA6dD6129e60a0', seed: 8453_001n, count: 128 },
  // OrderExecutor V3 · Arbitrum One (42161) — docs/DEPLOYMENTS.md "OrderExecutor V3 · Arbitrum One".
  { key: 'V3_ARB', version: 3, chainId: 42161, executor: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459', seed: 42161_001n, count: 128 },
  // The route still accepts v2-signed orders on chains with a v2 executor (config.ts ORDER_EXECUTOR_BY_CHAIN).
  { key: 'V2_MAINNET', version: 2, chainId: 1, executor: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130', seed: 1_002n, count: 48 },
  { key: 'V2_BASE', version: 2, chainId: 8453, executor: '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598', seed: 8453_002n, count: 48 },
]

const U256 = [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] as const
const MASK160 = (1n << 160n) - 1n

function word(seed: bigint, i: number, k: number): bigint {
  return BigInt(keccak256(encodeAbiParameters(U256, [seed, BigInt(i), BigInt(k)])))
}
function mag(x: bigint): bigint {
  return x >> (x % 256n)
}
/** Low 160 bits as an address; odd indices checksummed, even ones lower case (the route accepts both). */
function addr(x: bigint, i: number): string {
  const lower = `0x${(x & MASK160).toString(16).padStart(40, '0')}`
  return i % 2 === 1 ? getAddress(lower) : lower
}

/**
 * Order `i` of a set, as the JSON body of POST /api/orders carries it to the EIP-712 message:
 * uint256 fields as decimal strings, enums and maxSlippageBps as numbers, addresses as strings.
 */
export function orderMessage(set: Pick<VectorSet, 'seed' | 'version'>, i: number): Record<string, unknown> {
  const w = (k: number) => word(set.seed, i, k)
  const orderType = i % 3 // 0 LIMIT, 1 STOP_LOSS, 2 DCA
  const isDca = orderType === 2
  const w8 = w(8)
  const w12 = w(12)
  const w14 = w(14)
  const w15 = w(15)
  const dcaTotal = isDca
    ? [1n, 365n, 2n + (w15 % 363n)][Math.floor(i / 3) % 3]
    : w15 % 2n === 0n ? 1n : mag(w15)
  const dcaInterval = isDca ? mag(w14) : w14 % 2n === 0n ? 0n : mag(w14)
  return {
    owner: addr(w(0), i),
    tokenIn: addr(w(1), i),
    tokenOut: addr(w(2), i),
    amountIn: mag(w(3)).toString(),
    minAmountOut: mag(w(4)).toString(),
    ...(set.version === 3 ? { maxSlippageBps: Number(w(5) & 0xffffn) } : {}),
    orderType,
    condition: Number(w(6) % 2n),
    targetPrice: mag(w(7)).toString(),
    priceFeed: isDca && w8 % 2n === 0n ? zeroAddress : addr(w8, i),
    expiry: mag(w(9)).toString(),
    nonce: mag(w(10)).toString(),
    router: addr(w(11), i),
    routerDataHash: w12 % 4n === 0n ? zeroHash : (`0x${w(13).toString(16).padStart(64, '0')}` as Hex),
    dcaInterval: dcaInterval.toString(),
    dcaTotal: dcaTotal.toString(),
  }
}

/** The domain the route recovers a signature under on that chain (getOrderExecutor{,V3}Domain shape). */
export function vectorDomain(set: VectorSet) {
  return {
    name: 'TeraSwapOrderExecutor' as const,
    version: set.version === 3 ? ('3' as const) : ('2' as const),
    chainId: set.chainId,
    verifyingContract: set.executor,
  }
}

export interface Vector { message: Record<string, unknown>; structHash: Hex; digest: Hex }

export function vectorsFor(set: VectorSet): Vector[] {
  const types = set.version === 3 ? ORDER_V3_EIP712_TYPES : ORDER_EIP712_TYPES
  const domain = vectorDomain(set)
  return Array.from({ length: set.count }, (_, i) => {
    const message = orderMessage(set, i)
    return {
      message,
      structHash: computeOrderHash({ types, message }),
      digest: computeOrderDigest({ domain, types, message }),
    }
  })
}

function hexBlock(hashes: readonly Hex[]): string {
  return hashes.map((h, i) => `        /* ${String(i).padStart(3)} */ hex"${h.slice(2)}"`).join('\n')
}

/** The full text of contracts/order-engine/test/OrderHashVectors.sol. */
export function renderVectorsSolidity(): string {
  const body = VECTOR_SETS.map((set) => {
    const v = vectorsFor(set)
    return [
      `    // ${set.key}: v${set.version} executor ${set.executor} on chain ${set.chainId}`,
      `    uint256 internal constant ${set.key}_CHAIN_ID = ${set.chainId};`,
      `    address internal constant ${set.key}_EXECUTOR = ${set.executor};`,
      `    uint256 internal constant ${set.key}_SEED = ${set.seed};`,
      `    uint256 internal constant ${set.key}_COUNT = ${set.count};`,
      `    bytes internal constant ${set.key}_STRUCT =`,
      `${hexBlock(v.map((x) => x.structHash))};`,
      `    bytes internal constant ${set.key}_DIGEST =`,
      `${hexBlock(v.map((x) => x.digest))};`,
    ].join('\n')
  }).join('\n\n')
  return [
    '// SPDX-License-Identifier: MIT',
    '// GENERATED by scripts/orders/gen-order-hash-vectors.ts from the server function',
    '// src/lib/order-engine/order-hash.ts. Do not edit: scripts/orders/order-hash-vectors.test.ts fails',
    '// when this file differs from what the generator renders.',
    '// _STRUCT[i] = computeOrderHash(order i)   (expected = executor.getOrderHash(order i))',
    '// _DIGEST[i] = computeOrderDigest(order i) (expected = keccak256(0x1901 | executor.domainSeparator() | getOrderHash))',
    'pragma solidity ^0.8.20;',
    '',
    'library OrderHashVectors {',
    body,
    '}',
    '',
  ].join('\n')
}
