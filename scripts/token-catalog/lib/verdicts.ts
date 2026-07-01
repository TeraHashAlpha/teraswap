/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Shared guard-verdict collector — EXTRACTED VERBATIM from
 * scripts/refresh-catalog-guard.ts (PRs #209–#211) so the catalog pipeline can route its
 * candidates through the SAME on-chain probes instead of reimplementing them. The refresh
 * script is now a thin CLI over this module; the probe semantics and the committed
 * trust-fixture format are byte-identical to the pre-extraction behavior.
 *
 * Signals per token (all failures NON-FATAL → null = "unknown / don't fail on infra"):
 *   • inTrustedList — address present in CoinGecko's per-chain token list (by address)
 *   • hasBytecode   — on-chain getCode(address) is non-empty (catches DEAD addresses)
 *   • transferable  — read-only eth_call of transfer(0x…dead, 0) does NOT revert (advisory)
 *   • onchainSymbol — on-chain symbol() (binds the verdict to the token IDENTITY)
 *   • decimals      — on-chain decimals() (FATAL cross-check vs the catalog in the guard)
 */
import { createPublicClient, http, getAddress, encodeFunctionData } from 'viem'
import type { Verdict } from '@/lib/chains/catalog-guard'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const GUARD_CHAINS = [1, 8453] as const

export const GUARD_RPC: Record<number, string> = {
  1: process.env.GUARD_RPC_1 ?? 'https://ethereum-rpc.publicnode.com',
  8453: process.env.GUARD_RPC_8453 ?? 'https://base-rpc.publicnode.com',
}

export const CG_PLATFORM: Record<number, string> = { 1: 'ethereum', 8453: 'base' }

const DEAD = '0x000000000000000000000000000000000000dEaD'
const FROM = '0x0000000000000000000000000000000000000001'
const transferAbi = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const
const symbolAbi = [{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const
const decimalsAbi = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const

/** CoinGecko per-chain address set (the guard's trusted list). null = unreachable. */
export async function cgAddressSet(chainId: number): Promise<Set<string> | null> {
  try {
    const res = await fetch(`https://tokens.coingecko.com/${CG_PLATFORM[chainId]}/all.json`)
    if (!res.ok) return null
    const data = (await res.json()) as { tokens?: Array<{ address?: string }> }
    return new Set((data.tokens ?? []).filter((t) => typeof t.address === 'string').map((t) => t.address!.toLowerCase()))
  } catch {
    return null
  }
}

/** The on-chain probe — identical to the original refresh script's `onchain()`. */
export async function onchainProbe(client: ReturnType<typeof createPublicClient>, address: string) {
  let a: `0x${string}`
  try { a = getAddress(address) } catch { return { hasBytecode: null, transferable: null, onchainSymbol: null, decimals: null } }
  let hasBytecode: boolean | null = null
  try {
    const code = await client.getCode({ address: a })
    hasBytecode = !!code && code !== '0x'
  } catch { return { hasBytecode: null, transferable: null, onchainSymbol: null, decimals: null } }
  if (!hasBytecode) return { hasBytecode, transferable: false, onchainSymbol: null, decimals: null }
  // On-chain symbol() binds the verdict to the token IDENTITY (catches a typo to ANOTHER live
  // token under the same catalog symbol). null when symbol() is bytes32/missing/RPC-fails.
  let onchainSymbol: string | null = null
  try {
    const s = await client.readContract({ address: a, abi: symbolAbi, functionName: 'symbol' })
    onchainSymbol = typeof s === 'string' && s.length > 0 && s.length <= 32 ? s : null
  } catch { onchainSymbol = null }
  // On-chain decimals() — cross-checked vs the catalog (fund-affecting; the swap path sizes amounts with it).
  let decimals: number | null = null
  try {
    const d = await client.readContract({ address: a, abi: decimalsAbi, functionName: 'decimals' })
    decimals = typeof d === 'number' ? d : Number(d)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) decimals = null
  } catch { decimals = null }
  try {
    await client.call({ account: FROM as `0x${string}`, to: a, data: encodeFunctionData({ abi: transferAbi, functionName: 'transfer', args: [DEAD, 0n] }) })
    return { hasBytecode, transferable: true, onchainSymbol, decimals }
  } catch (e: unknown) {
    const msg = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? '').toLowerCase()
    if (msg.includes('revert') || msg.includes('execution')) return { hasBytecode, transferable: false, onchainSymbol, decimals }
    return { hasBytecode, transferable: null, onchainSymbol, decimals } // RPC/infra — unknown, non-fatal
  }
}

export interface TokenIdentity {
  chainId: number
  address: string
  symbol: string
}

/**
 * Collect verdicts for an arbitrary token set (the refresh script passes the live catalog;
 * the pipeline passes its candidates). `cgSets` lets a caller inject an already-fetched
 * CoinGecko address set per chain (the pipeline reuses its own coingecko source fetch);
 * chains without an injected set are fetched here, exactly like the original script.
 */
export async function collectVerdicts(
  tokens: TokenIdentity[],
  opts: {
    concurrency?: number
    log?: (msg: string) => void
    cgSets?: Map<number, Set<string> | null>
  } = {},
): Promise<Verdict[]> {
  const log = opts.log ?? ((m: string) => console.error(m))
  const Q = opts.concurrency ?? 10
  const out: Verdict[] = []
  const chainIds = [...new Set(tokens.map((t) => t.chainId))]
  for (const chainId of chainIds) {
    let cgSet = opts.cgSets?.get(chainId)
    if (cgSet === undefined) cgSet = await cgAddressSet(chainId)
    if (!cgSet) log(`WARN: could not fetch CoinGecko ${CG_PLATFORM[chainId]} list — inTrustedList=null for chain ${chainId}`)
    const client = createPublicClient({ transport: http(GUARD_RPC[chainId]) })
    const cat = tokens.filter((t) => t.chainId === chainId)
    log(`chain ${chainId}: ${cat.length} tokens`)
    let i = 0
    const rows: Verdict[] = new Array(cat.length)
    await Promise.all(Array.from({ length: Q }, async () => {
      while (i < cat.length) {
        const idx = i++
        const t = cat[idx]
        const oc = await onchainProbe(client, t.address)
        rows[idx] = {
          chainId,
          address: t.address,
          symbol: t.symbol,
          inTrustedList: cgSet ? cgSet.has(t.address.toLowerCase()) : null,
          hasBytecode: oc.hasBytecode,
          transferable: oc.transferable,
          onchainSymbol: oc.onchainSymbol,
          decimals: oc.decimals,
        }
        if (idx % 50 === 0) log(`  ${chainId}: ${idx}/${cat.length}`)
      }
    }))
    out.push(...rows)
  }
  return out
}

// Codepoint sort (NOT localeCompare — locale/ICU-independent so the committed bytes are
// identical across machines/CI).
const cp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function sortVerdictsInPlace(rows: Verdict[]): Verdict[] {
  rows.sort((a, b) => a.chainId - b.chainId || cp(String(a.symbol), String(b.symbol)) || cp(String(a.address), String(b.address)))
  return rows
}

/** Write the committed trust fixture — byte-identical format to the original script. */
export function writeTrustFixture(
  verdicts: Verdict[],
  chains: readonly number[] = GUARD_CHAINS,
  file = path.join('src', 'lib', 'chains', 'catalog-guard.trust.json'),
): { file: string; count: number } {
  const out = sortVerdictsInPlace([...verdicts])
  const payload = {
    $comment: 'GENERATED by scripts/refresh-catalog-guard.ts — do not hand-edit. Deterministic verdict cache read by catalog-address-guard.test.ts (no network at test time). Re-run the script + commit when the catalog changes.',
    generatedFromChains: chains,
    tokens: out,
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 1) + '\n')
  return { file, count: out.length }
}
