#!/usr/bin/env node
/**
 * [SPRINT-9Y] Token-catalog generator.
 *
 * Bakes a PINNED, validated token catalog into `src/lib/chains/token-catalog.generated.ts`
 * from a vendored authoritative token-list snapshot. Addresses are NEVER hand-typed — every
 * entry is copied programmatically from the snapshot and validated:
 *   - EIP-55 checksum + runtime validity via viem `getAddress`
 *   - integer decimals in [0, 36]
 *   - chainId matches the target chain
 *
 * Sources (pinned):
 *   - Uniswap Labs Default list — chainId 1 (mainnet) + 8453 (Base).
 *     scripts/token-lists/uniswap-default-v21.3.0.json
 *   - One Base-only addition (USDT): Uniswap's Base list omits bridged USDT, so the single
 *     USDT/Base entry is sourced from the CoinGecko Base list and passed via --usdt-base.
 *
 * Regenerate:  node scripts/generate-token-catalog.mjs
 * The committed .generated.ts file IS the pin — review every address there.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getAddress } from 'viem'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const SNAPSHOT = join(ROOT, 'scripts/token-lists/uniswap-default-v21.3.0.json')
const OUT = join(ROOT, 'src/lib/chains/token-catalog.generated.ts')
const TARGET_CHAINS = [1, 8453]

// Bridged USDT on Base — Uniswap's Base list omits it. Sourced + spot-checked from the
// CoinGecko Base list (v430.1.0, 2026-06-08): "L2 Standard Bridged USDT (Base)".
const BASE_USDT = {
  chainId: 8453,
  address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  symbol: 'USDT',
  name: 'Tether USD',
  decimals: 6,
  logoURI: 'https://assets.coingecko.com/coins/images/325/large/Tether.png',
}

// [CHORE-CATALOG-CLEANUP] Curated corrections to the vendored Uniswap snapshot — deprecated /
// migrated tokens the catalog-address-guard (#209) surfaced, each VERIFIED on-chain (name/symbol/
// decimals/transferability) + authoritative sources (Etherscan + official + CoinGecko). See FEEDBACK
// for the per-token disposition. Keyed by `chainId:loweraddress`.
//
// REMOVALS — drop the entry entirely (canonical is dead/non-routable, or already present):
const REMOVALS = new Set([
  '1:0xa4e8c3ec456107ea67d3075bf9e3df3a75823db0', // LOOM — migrated to 0x42476f74…; the new token is DEX-dead (~$30 24h, fee-tier dust pools) → non-routable, remove.
  '1:0x36e66fbbce51e4cd5bd3c62b637eb411b18949d4', // OMNI — Omni Network rebranded + redenominated 1:75 to Nomina (NOM, 0x6e6F6d…); the successor is non-routable on DEX (single ~$610-TVL pool) and trades under a different ticker → remove.
  '1:0x1985365e9f78359a9b6ad760e32412f4a445e862', // REP — Augur "Reputation v1", deprecated; REPv2 (0x221657…) is already a separate catalog entry → remove (would duplicate).
])
// REMAPS — replace a deprecated address with the verified canonical token (full metadata):
const REMAPS = {
  // LCX V1 "Old Contract" → LCX Token 2.0 (1:1 upgrade; CoinGecko/CMC moved to the new address; active liquidity).
  '1:0x037a54aab062628c9bbae1fdb1583c195585fe41': { chainId: 1, address: '0x8cd41041505885ef0ad3858181d66f17be8aae7e', symbol: 'LCX', name: 'LCX', decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/9985/large/256_lcxlogo.png?1770805695' },
  // Rubic "Old RBC Token" (NON-TRANSFERABLE on-chain — transfer reverts) → migrated 1:1 RUBIC TOKEN (transferable).
  '1:0xa4eed63db85311e22df4473f87ccfc3dadcfa3e3': { chainId: 1, address: '0x3330bfb7332ca23cd071631837dc289b09c33333', symbol: 'RBC', name: 'Rubic', decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/12629/large/rubic.png?1696512437' },
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function validate(t) {
  if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) {
    throw new Error(`bad decimals: ${t.chainId} ${t.symbol} ${t.decimals}`)
  }
  // getAddress throws on a bad checksum / invalid address. Re-checksums to EIP-55.
  return getAddress(t.address)
}

function q(s) {
  // single-quoted JS string literal, matching the repo style; escape backslash + quote, drop newlines.
  return "'" + String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' ') + "'"
}

function buildChain(tokens, chainId) {
  const seen = new Set()
  const out = []
  for (const t of tokens) {
    if (t.chainId !== chainId) continue
    let address = validate(t)
    let entry = { address, symbol: t.symbol, name: t.name, decimals: t.decimals, logoURI: t.logoURI || '' }
    // [CHORE-CATALOG-CLEANUP] apply curated removals / remaps before dedup.
    const srcKey = `${chainId}:${address.toLowerCase()}`
    if (REMOVALS.has(srcKey)) continue
    const remap = REMAPS[srcKey]
    if (remap) {
      address = validate(remap)
      entry = { address, symbol: remap.symbol, name: remap.name, decimals: remap.decimals, logoURI: remap.logoURI }
    }
    const key = address.toLowerCase()
    if (seen.has(key)) continue // first occurrence wins
    seen.add(key)
    out.push(entry)
  }
  // deterministic order → stable diffs: symbol (case-insensitive) then address
  out.sort((a, b) => a.symbol.toLowerCase().localeCompare(b.symbol.toLowerCase()) || a.address.localeCompare(b.address))
  return out
}

const raw = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
const allTokens = [...raw.tokens, BASE_USDT]
validate(BASE_USDT) // fail fast if the one manual-source addition is malformed

const catalog = {}
for (const cid of TARGET_CHAINS) catalog[cid] = buildChain(allTokens, cid)

const version = `${raw.version.major}.${raw.version.minor}.${raw.version.patch}`
const digest = sha256(SNAPSHOT)

const lines = []
lines.push('/**')
lines.push(' * AUTO-GENERATED by scripts/generate-token-catalog.mjs — DO NOT EDIT BY HAND.')
lines.push(' * [SPRINT-9Y] Pinned, validated per-chain token catalog (the searchable long tail).')
lines.push(' *')
lines.push(` * Source: "${raw.name}" v${version} (timestamp ${raw.timestamp})`)
lines.push(' *   https://tokens.uniswap.org  (vendored: scripts/token-lists/uniswap-default-v21.3.0.json)')
lines.push(` *   snapshot sha256: ${digest}`)
lines.push(' * Base USDT (bridged) added from CoinGecko Base list v430.1.0 — Uniswap omits it.')
lines.push(' *')
lines.push(' * Every address validated: viem getAddress (EIP-55) + chainId + integer decimals.')
lines.push(` * Counts: chain 1 = ${catalog[1].length}, chain 8453 = ${catalog[8453].length}.`)
lines.push(' */')
lines.push('')
lines.push('export interface GeneratedToken {')
lines.push('  address: `0x${string}`')
lines.push('  symbol: string')
lines.push('  name: string')
lines.push('  decimals: number')
lines.push('  logoURI: string')
lines.push('}')
lines.push('')
lines.push('export const GENERATED_TOKEN_CATALOG: Record<number, GeneratedToken[]> = {')
for (const cid of TARGET_CHAINS) {
  lines.push(`  ${cid}: [`)
  for (const t of catalog[cid]) {
    lines.push(`    { address: ${q(t.address)}, symbol: ${q(t.symbol)}, name: ${q(t.name)}, decimals: ${t.decimals}, logoURI: ${q(t.logoURI)} },`)
  }
  lines.push('  ],')
}
lines.push('}')
lines.push('')

writeFileSync(OUT, lines.join('\n'))
console.log(`wrote ${OUT}`)
console.log(`source v${version} sha256=${digest}`)
for (const cid of TARGET_CHAINS) console.log(`  chain ${cid}: ${catalog[cid].length} tokens`)
