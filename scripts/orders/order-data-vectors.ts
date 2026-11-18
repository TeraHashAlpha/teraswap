/**
 * [fix/server-builds-order-data, A86 S-4/S-5] Seeded VALID orders for the order_data differential.
 *
 * src/app/api/orders/orders-order-data-differential.test.ts signs each order, POSTs it to the real route, and runs what the
 * keeper does with the stored row (its routing call and struct literal, sliced from the shipped executor.js). It renders
 * contracts/order-engine/test/OrderDataVectors.sol from what it observed:
 *   _STORED[i]       the order_hash the route stored for order i;
 *   _KEEPER_DIGEST   a hash chain over abi.encode(the keeper's struct) for every order of the set, in order:
 *                    d_0 = 0, d_{i+1} = keccak256(d_i ‖ abi.encode(struct_i)).
 * OrderDataDifferential.t.sol rebuilds every order from (seed, i) with the SAME derivation as orderFields() below, calls the
 * executor's own getOrderHash on it (real bytecode at the production address, production chain id), compares with
 * _STORED[i], and rebuilds the same chain over abi.encode(its struct): equal digests mean the structs Foundry hashed are
 * byte for byte the keeper's. The test fails when the committed .sol is not what it renders (toMatchFileSnapshot).
 *
 * Derivation (MUST match OrderDataDifferential.t.sol _fields()): w(k) = uint256(keccak256(abi.encode(seed, i, k))).
 * Every value is inside what POST /api/orders accepts (expiry within 90 days, amount and DCA chunk >= 10,000, DCA 2-365
 * buys and interval >= 60 s, a feed for Limit/TP, a whitelisted router and pinned calldata for a v3 Limit/TP, Limit/TP v3
 * on Base only, no Stop-Loss BELOW).
 */
import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem'

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
/** The pinned calldata's selector: arbitrary, only its keccak256 is signed. */
export const ROUTER_DATA_SELECTOR = '12345678'

/** 0 = Limit, 1 = Take-Profit (orderType STOP_LOSS, condition ABOVE), 2 = DCA. */
export type Kind = 0 | 1 | 2

export interface DifferentialSet {
  /** Solidity constant prefix. */
  key: string
  version: 2 | 3
  chainId: number
  /** The executor the keeper on that chain sends this version to (docs/DEPLOYMENTS.md). */
  executor: `0x${string}`
  seed: bigint
  count: number
  kinds: readonly Kind[]
}

export const DIFFERENTIAL_SETS: readonly DifferentialSet[] = [
  { key: 'V3_BASE', version: 3, chainId: 8453, executor: '0x686b4f812291F4De238E59ED00BA6dD6129e60a0', seed: 8453_101n, count: 120, kinds: [0, 1, 2] },
  // Limit/TP v3 are Base-only (route.ts, LIMIT_TP_CHAIN_ID): Arbitrum takes DCA.
  { key: 'V3_ARB', version: 3, chainId: 42161, executor: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459', seed: 42161_101n, count: 80, kinds: [2] },
  { key: 'V2_BASE', version: 2, chainId: 8453, executor: '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598', seed: 8453_102n, count: 60, kinds: [0, 1, 2] },
  { key: 'V2_MAINNET', version: 2, chainId: 1, executor: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130', seed: 1_102n, count: 40, kinds: [0, 1, 2] },
]

const MASK160 = (1n << 160n) - 1n
const U256x3 = [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] as const

export function word(seed: bigint, i: number, k: number): bigint {
  return BigInt(keccak256(encodeAbiParameters(U256x3, [seed, BigInt(i), BigInt(k)])))
}
const hex32 = (x: bigint) => x.toString(16).padStart(64, '0')
const address = (x: bigint) => `0x${(x & MASK160).toString(16).padStart(40, '0')}` as `0x${string}`

export interface OrderFields {
  kind: Kind
  /** The signer's private key (never a real one: derived from the seed). */
  privateKey: Hex
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  amountIn: bigint
  minAmountOut: bigint
  maxSlippageBps?: number
  orderType: number
  condition: number
  targetPrice: bigint
  priceFeed: `0x${string}`
  expiry: bigint
  nonce: bigint
  router: `0x${string}`
  routerData?: Hex
  routerDataHash: Hex
  dcaInterval: bigint
  dcaTotal: bigint
}

/** Order `i` of `set`, in the chain's router list `routers` at time `nowS` (the owner is the address of privateKey). */
export function orderFields(set: DifferentialSet, i: number, routers: readonly `0x${string}`[], nowS: bigint): OrderFields {
  const w = (k: number) => word(set.seed, i, k)
  const kind = set.kinds[i % set.kinds.length]
  const isDca = kind === 2
  const pinned = !isDca && (set.version === 3 || w(12) % 3n !== 0n)
  const routerData = pinned ? (`0x${ROUTER_DATA_SELECTOR}${hex32(w(13))}${hex32(w(14))}` as Hex) : undefined
  return {
    kind,
    privateKey: `0x${hex32((w(0) % (SECP256K1_N - 1n)) + 1n)}`,
    tokenIn: address(w(1)),
    tokenOut: address(w(2)),
    amountIn: 10n ** 7n + (w(3) % 10n ** 27n),
    minAmountOut: 10n ** 20n + (w(4) % 10n ** 27n),
    ...(set.version === 3 ? { maxSlippageBps: Number(1n + (w(5) % 500n)) } : {}),
    orderType: kind,
    condition: kind === 1 ? 0 : Number(w(6) % 2n),
    targetPrice: isDca ? w(7) % 10n ** 14n : 1n + (w(7) % 10n ** 14n),
    priceFeed: isDca && w(8) % 2n === 0n ? '0x0000000000000000000000000000000000000000' : address(w(8)),
    expiry: nowS + 3600n + (w(9) % (89n * 86400n)),
    nonce: w(10) % 2n ** 31n,
    router: routers[Number(w(11) % BigInt(routers.length))],
    ...(routerData ? { routerData } : {}),
    routerDataHash: routerData ? keccak256(routerData) : (`0x${'0'.repeat(64)}` as Hex),
    dcaInterval: isDca ? 60n + (w(15) % (30n * 86400n)) : 0n,
    dcaTotal: isDca ? 2n + (w(16) % 364n) : 1n,
  }
}

/** One step of the keeper-struct chain: keccak256(prev ‖ abi.encode(struct)) for the schema `components`. */
export function chainStep(prev: Hex, components: readonly { name: string; type: string }[], struct: Record<string, unknown>): Hex {
  return keccak256(concat([prev, encodeAbiParameters([{ type: 'tuple', components }] as never, [struct] as never)]))
}

export interface SetResult { set: DifferentialSet; routers: readonly `0x${string}`[]; stored: Hex[]; keeperDigest: Hex }

function hexBlock(hashes: readonly Hex[]): string {
  return hashes.map((h, i) => `        /* ${String(i).padStart(3)} */ hex"${h.slice(2)}"`).join('\n')
}

/** The full text of contracts/order-engine/test/OrderDataVectors.sol. */
export function renderOrderDataVectors(results: readonly SetResult[], nowS: bigint): string {
  const body = results.map(({ set, routers, stored, keeperDigest }) => [
    `    // ${set.key}: v${set.version} executor ${set.executor} on chain ${set.chainId}`,
    `    uint256 internal constant ${set.key}_CHAIN_ID = ${set.chainId};`,
    `    address internal constant ${set.key}_EXECUTOR = ${set.executor};`,
    `    uint256 internal constant ${set.key}_SEED = ${set.seed};`,
    `    uint256 internal constant ${set.key}_COUNT = ${set.count};`,
    `    bytes internal constant ${set.key}_KINDS = hex"${set.kinds.map((k) => k.toString(16).padStart(2, '0')).join('')}";`,
    `    bytes internal constant ${set.key}_ROUTERS = hex"${routers.map((r) => r.slice(2).toLowerCase()).join('')}";`,
    `    bytes32 internal constant ${set.key}_KEEPER_DIGEST = ${keeperDigest};`,
    `    bytes internal constant ${set.key}_STORED =`,
    `${hexBlock(stored)};`,
  ].join('\n')).join('\n\n')
  return [
    '// SPDX-License-Identifier: MIT',
    '// GENERATED by src/app/api/orders/orders-order-data-differential.test.ts (scripts/orders/order-data-vectors.ts) from',
    '// what POST /api/orders stored and what the keeper built from it. Do not edit: that test fails when this file differs',
    '// from what it renders (regenerate: npx vitest run src/app/api/orders/orders-order-data-differential.test.ts -u).',
    '// _STORED[i] = the stored order_hash of order i; _KEEPER_DIGEST = chain of keccak256(prev | abi.encode(keeper struct)).',
    'pragma solidity ^0.8.20;',
    '',
    'library OrderDataVectors {',
    `    uint256 internal constant NOW = ${nowS};`,
    '',
    body,
    '}',
    '',
  ].join('\n')
}
