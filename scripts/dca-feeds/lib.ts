/**
 * [FEAT-DCA-FEED-REGISTRATION-PHASE1] Shared READ-ONLY helpers for plan.ts / verify.ts.
 * Only eth_call / eth_getCode / eth_chainId. No private key, no signing, no sendTransaction anywhere.
 * Addresses come from src/config/dca-feed-registrations.json (<- CSV) and docs/DEPLOYMENTS.md (parsed);
 * none is typed here. Every address passes the 42-char + EIP-55 sentinel; equality is always computed.
 * Runs on node >= 22.18 (native TypeScript type stripping): `node scripts/dca-feeds/plan.ts`.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../../src/config/dca-feed-registrations.json' with { type: 'json' }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const viem = createRequire(resolve(root, 'package.json'))('viem')
export const { createPublicClient, http, getAddress, parseAbi, encodeFunctionData, encodeAbiParameters, keccak256, toBytes, isAddress } = viem

export const ABI = parseAbi([
  'function queueTokenUsdFeed(address token,address feed,uint8 tokenDecimals,uint256 maxStaleness)',
  'function executeTokenUsdFeed(bytes32 actionId,address token,address feed,uint8 tokenDecimals,uint256 maxStaleness)',
  'function tokenUsdFeeds(address) view returns (address feed,uint8 feedDecimals,uint8 tokenDecimals,uint256 maxStaleness,bool registered)',
  'function admin() view returns (address)',
  'function TIMELOCK_ORACLE_CHANGE() view returns (uint256)',
  'function TIMELOCK_GRACE() view returns (uint256)',
])
const FEED_ABI = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
])
const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)'])

export const CHAINS: Record<string, { id: number; name: string; rpc: string[]; deploymentsLabel: string }> = {
  base: { id: 8453, name: 'Base', rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], deploymentsLabel: 'Base (8453)' },
  arbitrum: { id: 42161, name: 'Arbitrum', rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'], deploymentsLabel: 'Arbitrum One (42161)' },
}

export class SentinelError extends Error {}
export function sentinel(label: string, a: unknown): string {
  if (typeof a !== 'string' || a.length !== 42) throw new SentinelError(`SENTINEL ${label}: not a 42-char address: ${String(a)}`)
  if (!isAddress(a, { strict: false }) || getAddress(a) !== a) throw new SentinelError(`SENTINEL ${label}: fails EIP-55 checksum: ${a}`)
  return a
}
export const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The executor + admin for a chain, PARSED from docs/DEPLOYMENTS.md (never typed). */
export function deploymentsFor(chain: { deploymentsLabel: string }) {
  const lines = readFileSync(resolve(root, 'docs/DEPLOYMENTS.md'), 'utf8').split('\n')
  const hex = /`(0x[0-9a-fA-F]{40})`/
  const row = lines.find(l => l.startsWith('|') && l.includes('OrderExecutor V3') && l.includes(chain.deploymentsLabel))
  const m = row?.match(hex)
  if (!m) throw new SentinelError(`SENTINEL DEPLOYMENTS: no OrderExecutor V3 row for ${chain.deploymentsLabel}`)
  const adminRow = lines.find(l => l.startsWith('|') && l.includes('Contract admin'))
  const am = adminRow?.match(hex)
  if (!am) throw new SentinelError('SENTINEL DEPLOYMENTS: no "Contract admin" row')
  return { executor: sentinel(`${chain.deploymentsLabel} executor`, m[1]), admin: sentinel('DEPLOYMENTS admin', am[1]) }
}

export interface Row {
  symbol: string; token: string; feed: string; description: string; decimals: number; tokenDecimals: number
  heartbeat: number; maxStaleness: number | null; tier: string; phase: number; enabled: boolean; action: string; source: string
}
export function rowsFor(chainId: number): Row[] {
  return ((config.chains as Record<string, { rows: Row[] }>)[String(chainId)]?.rows ?? [])
}

export function clientsFor(chain: { rpc: string[] }) {
  return chain.rpc.map(url => createPublicClient({ transport: http(url, { retryCount: 2 }) }))
}

export interface LiveFeed { ok: boolean; reasons: string[]; description?: string; decimals?: number; answer?: string; ageSec?: number }
/** Live feed check: description() ends "/ USD" and equals the config, decimals() matches, answer > 0, fresh. */
export async function checkFeedLive(client: any, feed: string, exp: { description: string; decimals: number; heartbeat: number }): Promise<LiveFeed> {
  const reasons: string[] = []
  try {
    const code = await client.getCode({ address: feed })
    if (!code || code === '0x') return { ok: false, reasons: ['no contract code at feed'] }
    const [description, decimals, round] = await Promise.all([
      client.readContract({ address: feed, abi: FEED_ABI, functionName: 'description' }),
      client.readContract({ address: feed, abi: FEED_ABI, functionName: 'decimals' }),
      client.readContract({ address: feed, abi: FEED_ABI, functionName: 'latestRoundData' }),
    ])
    const answer = round[1] as bigint, updatedAt = Number(round[3])
    const ageSec = Math.floor(Date.now() / 1000) - updatedAt
    if (!String(description).endsWith('/ USD')) reasons.push(`description "${description}" does not end with "/ USD"`)
    if (description !== exp.description) reasons.push(`description "${description}" != config "${exp.description}"`)
    if (Number(decimals) !== exp.decimals) reasons.push(`decimals ${decimals} != config ${exp.decimals}`)
    if (!(answer > 0n)) reasons.push(`answer ${answer} not > 0`)
    if (ageSec > 2 * exp.heartbeat) reasons.push(`age ${ageSec}s > 2x heartbeat ${exp.heartbeat}s`)
    // executeTokenUsdFeed itself reverts ("Feed seems dead") when the feed is >= 24h stale at execution.
    if (ageSec >= 86400) reasons.push(`age ${ageSec}s >= 86400s: executeTokenUsdFeed would revert`)
    return { ok: reasons.length === 0, reasons, description, decimals: Number(decimals), answer: answer.toString(), ageSec }
  } catch (e) {
    return { ok: false, reasons: [`read failed: ${(e as Error).message.split('\n')[0]}`] }
  }
}

export async function readTokenDecimals(client: any, token: string): Promise<number> {
  return Number(await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }))
}

export interface Onchain { feed: string; feedDecimals: number; tokenDecimals: number; maxStaleness: bigint; registered: boolean }
export async function readOnchain(client: any, executor: string, token: string): Promise<Onchain> {
  const r = await client.readContract({ address: executor, abi: ABI, functionName: 'tokenUsdFeeds', args: [token] })
  return { feed: r[0], feedDecimals: Number(r[1]), tokenDecimals: Number(r[2]), maxStaleness: r[3], registered: r[4] }
}

/** A deterministic address with no code, computed from a label (negative control; never typed). */
export function deadAddress(): string {
  return getAddress('0x' + keccak256(toBytes('dca-feeds negative control')).slice(26))
}

export interface ChainContext { key: string; chain: typeof CHAINS[string]; executor: string; admin: string; clients: any[]; rows: Row[]; controls: any[] }

/** Build the per-chain context and run EVERY sentinel. Throws SentinelError on any failure. */
export async function buildContext(key: string): Promise<ChainContext> {
  const chain = CHAINS[key]
  if (!chain) throw new SentinelError(`unknown chain "${key}" (use: ${Object.keys(CHAINS).join(', ')})`)
  const rows = rowsFor(chain.id)
  if (rows.length === 0) throw new SentinelError(`SENTINEL: no config rows for chain ${chain.id}`)
  for (const r of rows) { sentinel(`${chain.name} ${r.symbol} token`, r.token); sentinel(`${chain.name} ${r.symbol} feed`, r.feed) }
  if (rows.some(r => r.phase === 2 && r.enabled)) throw new SentinelError('SENTINEL: a phase-2 row is enabled')
  const { executor, admin } = deploymentsFor(chain)
  const clients = clientsFor(chain)
  const primary = clients[0]
  const chainId = await primary.getChainId()
  if (chainId !== chain.id) throw new SentinelError(`SENTINEL: RPC chainId ${chainId} != ${chain.id}`)
  const code = await primary.getCode({ address: executor })
  if (!code || code === '0x') throw new SentinelError(`SENTINEL: no code at executor ${executor}`)
  const onchainAdmin = await primary.readContract({ address: executor, abi: ABI, functionName: 'admin' })
  if (!eq(onchainAdmin, admin)) throw new SentinelError(`SENTINEL: on-chain admin ${onchainAdmin} != DEPLOYMENTS admin ${admin}`)
  const controls: any[] = []
  // Negative control: a dead address must FAIL the live-feed check, or the check proves nothing.
  const dead = await checkFeedLive(primary, deadAddress(), { description: 'X / USD', decimals: 8, heartbeat: 3600 })
  if (dead.ok) throw new SentinelError('SENTINEL: negative control (dead address) PASSED the feed check - check is broken')
  controls.push({ control: 'negative: dead address', address: deadAddress(), result: 'FAIL as required', reasons: dead.reasons })
  // Positive control: every enabled phase-0 row (already registered, canonical) must read back equal and live.
  for (const r of rows.filter(x => x.phase === 0 && x.enabled)) {
    const on = await readOnchain(primary, executor, r.token)
    const live = await checkFeedLive(primary, r.feed, r)
    if (!on.registered || !eq(on.feed, r.feed) || !live.ok) {
      throw new SentinelError(`SENTINEL: positive control ${r.symbol} failed (registered=${on.registered} feed=${on.feed} live=${live.ok} ${live.reasons.join('; ')})`)
    }
    controls.push({ control: `positive: ${chain.name} ${r.symbol} registered feed == config, live ok, left unchanged`, token: r.token, feed: r.feed, result: 'PASS' })
  }
  return { key, chain, executor, admin, clients, rows, controls }
}

export function actionHash(token: string, feed: string, tokenDecimals: number, maxStaleness: bigint): string {
  return keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint256' }],
    ['setTokenUsdFeed', token, feed, tokenDecimals, maxStaleness]))
}
export function parseArgs(argv: string[]): { chains: string[] } {
  const i = argv.indexOf('--chain')
  const v = i >= 0 ? argv[i + 1] : undefined
  return { chains: v ? [v] : Object.keys(CHAINS) }
}
