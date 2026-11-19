/**
 * [fix/server-builds-order-data, A86 S-4/S-5] What the KEEPER does with a stored order_data, run from the keeper's own
 * code, not a copy of it:
 *   - keeperRoute(): the routing call as executor.js writes it (sliced from the shipped file) on the imported
 *     resolveExecutorRouting (executor-routing.js), with the keeper's per-chain executor addresses;
 *   - keeperOrderStruct(): the struct literal of executor.js "Use order_data directly" (sliced from the shipped file), run
 *     with viem's getAddress / zeroHash exactly as executor.js imports them.
 * executor.js runs main() on import, so it cannot be imported; the anchored-slice pattern is the one the keeper's own
 * tests use (chainlink-debug-read.test.mjs). Each anchor must occur exactly once, so a rewrite of either block fails here
 * instead of silently testing stale text.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getAddress, zeroHash } from 'viem'
import { resolveExecutorRouting } from '../../contracts/order-engine/executor/executor-routing.js'

const EXECUTOR_JS = resolve(__dirname, '../../contracts/order-engine/executor/executor.js')

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  if (a < 0) throw new Error(`anchor not found in executor.js: ${from}`)
  if (src.indexOf(from, a + 1) >= 0) throw new Error(`anchor occurs more than once in executor.js: ${from}`)
  const b = src.indexOf(to, a + from.length)
  if (b < 0) throw new Error(`end anchor not found after ${from}: ${to}`)
  return src.slice(a, b)
}

const SRC = readFileSync(EXECUTOR_JS, 'utf8')
/** `const routing = resolveExecutorRouting({ orderData: od, v2Address: CONTRACT_ADDRESS, … })` */
export const ROUTING_CALL = slice(SRC, 'const routing = resolveExecutorRouting({', 'if (!routing.ok) {')
/** `const orderStruct = { owner: getAddress(od.owner), … }` */
export const STRUCT_BLOCK = slice(SRC, '// Use order_data directly', 'log(`  Order struct:')

const routingFn = new Function(
  'resolveExecutorRouting', 'od', 'CONTRACT_ADDRESS', 'ORDER_EXECUTOR_ABI', 'V3_CONTRACT_ADDRESS', 'ORDER_EXECUTOR_V3_ABI',
  `${ROUTING_CALL}\nreturn routing`,
) as (...args: unknown[]) => KeeperRouting
const structFn = new Function('od', 'isV3', 'getAddress', 'zeroHash', `${STRUCT_BLOCK}\nreturn orderStruct`) as (
  ...args: unknown[]
) => Record<string, unknown>

export interface KeeperRouting { ok: boolean; isV3: boolean; execAddress: string | null; execAbi: unknown; reason: string }

/** The executor addresses a keeper on that chain is configured with (docs/DEPLOYMENTS.md; '' = none on that chain). */
export const KEEPER_EXECUTORS: Record<number, { v2: string; v3: string }> = {
  1: { v2: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130', v3: '' },
  8453: { v2: '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598', v3: '0x686b4f812291F4De238E59ED00BA6dD6129e60a0' },
  42161: { v2: '', v3: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459' },
}
const V2_ABI = Symbol('ORDER_EXECUTOR_ABI')
const V3_ABI = Symbol('ORDER_EXECUTOR_V3_ABI')

/** The keeper's routing decision for a stored order_data on `chainId`. */
export function keeperRoute(od: unknown, chainId: number): KeeperRouting {
  const ex = KEEPER_EXECUTORS[chainId]
  if (!ex) throw new Error(`no keeper executors for chain ${chainId}`)
  const r = routingFn(resolveExecutorRouting, od, ex.v2, V2_ABI, ex.v3, V3_ABI)
  if (r.ok && r.execAbi !== (r.isV3 ? V3_ABI : V2_ABI)) throw new Error('keeper routing returned the other ABI')
  return r
}

/** The struct the keeper passes to canExecute / executeOrder for this order_data. */
export function keeperOrderStruct(od: unknown, isV3: boolean): Record<string, unknown> {
  return structFn(od, isV3, getAddress, zeroHash)
}

/** order_data as the keeper receives it: a JSONB round trip (no bigint, no undefined, numbers as JSON numbers). */
export function asStored<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
