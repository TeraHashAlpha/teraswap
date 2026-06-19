/**
 * refresh-catalog-guard — regenerates the catalog-address-guard verdict cache.
 *
 *   npx tsx scripts/refresh-catalog-guard.ts
 *
 * For EVERY token in the curated catalog (src/lib/tokens.ts + src/lib/chains/tokens.ts,
 * chains 1 + 8453) it records three signals into a committed, DETERMINISTIC fixture
 * (src/lib/chains/catalog-guard.trust.json) that the vitest gate reads WITHOUT any network:
 *
 *   • inTrustedList  — address present in CoinGecko's per-chain token list (by address).
 *   • hasBytecode    — on-chain getCode(address) is non-empty (catches DEAD addresses).
 *   • transferable   — read-only eth_call of transfer(0x…dead, 0) does NOT revert
 *                      (advisory: some legit tokens — e.g. USDT — revert this probe).
 *
 * This script does the network I/O (CoinGecko fetch + RPC). ALL failures are NON-FATAL:
 * a token whose signal cannot be determined is written as `null` and the gate treats null
 * as "unknown / don't fail on infra". Re-run this whenever the catalog changes, then commit
 * the updated fixture. The gate (catalog-address-guard.test.ts) NEVER hits the network.
 */
import { getFullCatalog } from '@/lib/chains/tokens'
import { NATIVE_ETH } from '@/lib/constants'
import { createPublicClient, http, getAddress, encodeFunctionData } from 'viem'
import * as fs from 'node:fs'
import * as path from 'node:path'

const CHAINS = [1, 8453] as const
const RPC: Record<number, string> = {
  1: process.env.GUARD_RPC_1 ?? 'https://ethereum-rpc.publicnode.com',
  8453: process.env.GUARD_RPC_8453 ?? 'https://base-rpc.publicnode.com',
}
const CG_PLATFORM: Record<number, string> = { 1: 'ethereum', 8453: 'base' }
const DEAD = '0x000000000000000000000000000000000000dEaD'
const FROM = '0x0000000000000000000000000000000000000001'
const transferAbi = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const
const symbolAbi = [{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const
const decimalsAbi = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const

async function cgAddressSet(chainId: number): Promise<Set<string> | null> {
  try {
    const res = await fetch(`https://tokens.coingecko.com/${CG_PLATFORM[chainId]}/all.json`)
    if (!res.ok) return null
    const data = (await res.json()) as { tokens?: Array<{ address?: string }> }
    return new Set((data.tokens ?? []).filter((t) => typeof t.address === 'string').map((t) => t.address!.toLowerCase()))
  } catch {
    return null
  }
}

async function onchain(client: ReturnType<typeof createPublicClient>, address: string) {
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

async function run() {
  const out: Array<Record<string, unknown>> = []
  for (const chainId of CHAINS) {
    const cgSet = await cgAddressSet(chainId)
    if (!cgSet) console.error(`WARN: could not fetch CoinGecko ${CG_PLATFORM[chainId]} list — inTrustedList=null for chain ${chainId}`)
    const client = createPublicClient({ transport: http(RPC[chainId]) })
    const cat = getFullCatalog(chainId).filter((t) => t.address.toLowerCase() !== NATIVE_ETH.toLowerCase())
    console.error(`chain ${chainId}: ${cat.length} tokens`)
    const Q = 10
    let i = 0
    const rows: Array<Record<string, unknown>> = new Array(cat.length)
    await Promise.all(Array.from({ length: Q }, async () => {
      while (i < cat.length) {
        const idx = i++
        const t = cat[idx]
        const oc = await onchain(client, t.address)
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
        if (idx % 50 === 0) console.error(`  ${chainId}: ${idx}/${cat.length}`)
      }
    }))
    out.push(...rows)
  }
  // Codepoint sort (NOT localeCompare — locale/ICU-independent so the committed bytes are
  // identical across machines/CI).
  const cp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  out.sort((a, b) => (a.chainId as number) - (b.chainId as number) || cp(String(a.symbol), String(b.symbol)) || cp(String(a.address), String(b.address)))
  const file = path.join('src', 'lib', 'chains', 'catalog-guard.trust.json')
  const payload = {
    $comment: 'GENERATED by scripts/refresh-catalog-guard.ts — do not hand-edit. Deterministic verdict cache read by catalog-address-guard.test.ts (no network at test time). Re-run the script + commit when the catalog changes.',
    generatedFromChains: CHAINS,
    tokens: out,
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 1) + '\n')
  const dead = out.filter((v) => v.hasBytecode === false)
  const notInList = out.filter((v) => v.inTrustedList === false)
  const nonTransfer = out.filter((v) => v.transferable === false)
  console.error(`\nwrote ${file}: ${out.length} verdicts`)
  console.error(`  hasBytecode=false (DEAD): ${dead.length}  -> ${dead.map((v) => v.symbol).join(', ') || 'none'}`)
  console.error(`  inTrustedList=false: ${notInList.length}`)
  console.error(`  transferable=false (advisory): ${nonTransfer.length}`)
}
run()
