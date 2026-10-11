#!/usr/bin/env node
/**
 * [FEAT-DCA-FEED-REGISTRATION-PHASE1] Build src/config/dca-feed-registrations.json from the owner's
 * inventory CSV (outside the repo) + the tokens' own `decimals()` (read-only eth_call).
 * Addresses flow CSV -> config; nothing is hand-typed. Every address must be 42 chars AND equal its
 * EIP-55 checksum, or the run refuses.
 *
 *   node scripts/dca-feeds/build-config.mjs <inventory.csv>
 *
 * Owner decisions 2026-10-11: phase 1 = Chainlink "low" tier, only the named symbols; Base USDC's feed
 * is REPLACED by the plain proxy; everything else (medium tier, MOG) is phase 2, enabled:false.
 * maxStaleness rule per chain, as already registered: Arbitrum 2*(hb+13)+60, Base hb+3600.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { createPublicClient, http, getAddress, parseAbi } = createRequire(resolve(root, 'package.json'))('viem')

const CHAINS = {
  Base: { id: 8453, rpc: 'https://mainnet.base.org' },
  Arbitrum: { id: 42161, rpc: 'https://arb1.arbitrum.io/rpc' },
}
const PHASE1 = {
  Base: ['USDT', 'cbBTC', 'EURC', 'COMP', 'VIRTUAL'],
  Arbitrum: ['USDT', 'DAI', 'WBTC', 'LINK', 'ARB', 'AAVE', 'COMP', 'CRV', 'LDO', 'MAGIC', 'PENDLE', 'SUSHI', 'UNI'],
}
const REPLACE = { Base: ['USDC'], Arbitrum: [] } // feed replaced by the directory's plain proxy
const CONTROL = { Base: ['WETH'], Arbitrum: [] } // already registered + canonical: positive control, never changed

// Minimal CSV (the file has quoted fields containing commas).
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = '' }
    else if (c !== '\r') f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  const [head, ...body] = rows.filter(r => r.length > 1)
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}
function sentinel(label, a) {
  if (typeof a !== 'string' || a.length !== 42) throw new Error(`SENTINEL: ${label} not 42 chars: ${a}`)
  if (getAddress(a) !== a) throw new Error(`SENTINEL: ${label} fails EIP-55 checksum: ${a}`)
}
const maxStaleness = (chain, hb) => (chain === 'Arbitrum' ? 2 * (hb + 13) + 60 : hb + 3600)

const csvPath = process.argv[2]
if (!csvPath) { console.error('usage: build-config.mjs <inventory.csv>'); process.exit(2) }
const csv = parseCsv(readFileSync(csvPath, 'utf8'))
const date = (csvPath.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] ?? 'unknown'
const out = { schema: 1, source: `chainlink-directory ${date}`, chains: {} }
const ERC20 = parseAbi(['function decimals() view returns (uint8)'])

for (const [chain, meta] of Object.entries(CHAINS)) {
  const client = createPublicClient({ transport: http(meta.rpc) })
  const rows = []
  for (const r of csv.filter(x => x.chain === chain)) {
    const phase1 = PHASE1[chain].includes(r.symbol), replace = REPLACE[chain].includes(r.symbol), control = CONTROL[chain].includes(r.symbol)
    if (!r.cl_feed) continue // no directory feed: nothing to register
    sentinel(`${chain} ${r.symbol} token`, r.token); sentinel(`${chain} ${r.symbol} feed`, r.cl_feed)
    const hb = Number(r.cl_heartbeat)
    const row = {
      symbol: r.symbol, token: r.token, feed: r.cl_feed, description: r.cl_desc,
      decimals: Number(r.cl_decimals), tokenDecimals: Number(await client.readContract({ address: r.token, abi: ERC20, functionName: 'decimals' })),
      heartbeat: hb, maxStaleness: null, tier: r.cl_tier, phase: 2, enabled: false,
      action: 'none', source: `chainlink-directory ${date}`,
    }
    if (phase1 || replace) {
      if (r.cl_tier !== 'low' || r.fresh !== 'True' || r.rpc_agree !== 'True') throw new Error(`${chain} ${r.symbol}: not a fresh, RPC-agreed low-tier row`)
      Object.assign(row, { phase: 1, enabled: true, action: replace ? 'replace' : 'register', maxStaleness: maxStaleness(chain, hb) })
    } else if (control) {
      Object.assign(row, { phase: 0, enabled: true, action: 'none' }) // maxStaleness null => not compared
    } else if (r.status !== 'registrable-now' || r.cl_tier === 'low') {
      if (r.status === 'registered') continue
      if (r.cl_tier === 'low') console.error(`NOTE: ${chain} ${r.symbol} is low-tier but not in the owner's phase-1 list -> phase 2, disabled`)
    }
    if (row.phase === 2) row.maxStaleness = maxStaleness(chain, hb)
    rows.push(row)
  }
  for (const s of [...PHASE1[chain], ...REPLACE[chain], ...CONTROL[chain]]) {
    if (!rows.some(x => x.symbol === s)) throw new Error(`${chain} ${s} named by the owner but missing from the CSV`)
  }
  out.chains[meta.id] = { name: chain, rows }
}
writeFileSync(resolve(root, 'src/config/dca-feed-registrations.json'), JSON.stringify(out, null, 2) + '\n')
for (const [id, c] of Object.entries(out.chains)) {
  const by = {}; for (const r of c.rows) { const k = `phase${r.phase}${r.enabled ? '/enabled' : '/disabled'}`; by[k] = (by[k] || 0) + 1 }
  console.log(id, c.name, c.rows.length, JSON.stringify(by))
}
