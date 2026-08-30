#!/usr/bin/env node
/**
 * Copy production contract rows from docs/DEPLOYMENTS.md into README.md.
 *
 * Never retypes a hex. Never alters an address already in the README table.
 * Prints a length sentinel (42) for every address it copies.
 *
 * Extends the table with the Base OrderExecutor v2 and Arbitrum V3 rows
 * that the README omitted, and qualifies v2 vs V3 per chain using the
 * DEPLOYMENTS.md role text.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOYMENTS = path.join(ROOT, 'docs/DEPLOYMENTS.md')
const README = path.join(ROOT, 'README.md')
const ADDR_RE = /`(0x[0-9a-fA-F]{40})`/

export function stripMd(s) {
  return s.replace(/\*\*/g, '').replace(/`/g, '').trim()
}

export function parseDeploymentRows(md) {
  const rows = []
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue
    const m = line.match(ADDR_RE)
    if (!m) continue
    const address = m[1]
    if (address.length !== 42) {
      throw new Error(`address length ${address.length} !== 42: ${address}`)
    }
    const cells = line.split('|').map((c) => c.trim())
    const role = stripMd(cells[1] || '')
    const chain = stripMd(cells[2] || '')
    if (/testnet|sepolia|frozen|deprecated/i.test(role + ' ' + chain)) continue
    rows.push({ role, chain, address, line })
  }
  return rows
}

export function findRow(rows, roleRe, chainRe, label) {
  const hits = rows.filter((r) => roleRe.test(r.role) && chainRe.test(r.chain))
  if (hits.length !== 1) {
    throw new Error(`${label}: expected 1 row, got ${hits.length} (${hits.map((h) => h.role + ' / ' + h.chain).join('; ')})`)
  }
  return hits[0]
}

export function extractReadmeTableAddresses(md) {
  const start = md.indexOf('| Contract | Network | Address |')
  if (start < 0) throw new Error('README contract table not found')
  const after = md.slice(start)
  const endRel = after.search(/\n\nAll contracts are MIT/)
  if (endRel < 0) throw new Error('README table terminator not found')
  const table = after.slice(0, endRel)
  const addrs = []
  for (const line of table.split('\n')) {
    const m = line.match(ADDR_RE)
    if (m) addrs.push(m[1])
  }
  return { start, end: start + endRel, table, addrs }
}

function cell(contract, network, address) {
  if (address.length !== 42) {
    throw new Error(`refusing to write address of length ${address.length}`)
  }
  process.stdout.write(`length-sentinel ${address} ${address.length}\n`)
  return `| ${contract} | ${network} | \`${address}\` |`
}

function main() {
  const deploymentsMd = readFileSync(DEPLOYMENTS, 'utf8')
  const readmeMd = readFileSync(README, 'utf8')
  const rows = parseDeploymentRows(deploymentsMd)

  const feeV2Mainnet = findRow(rows, /FeeCollector V2/, /Ethereum Mainnet/, 'FeeCollector V2 mainnet')
  const feeBase = findRow(rows, /^FeeCollector \(instant/, /Base \(8453\)/, 'FeeCollector Base')
  const feeArb = findRow(rows, /^FeeCollector \(instant/, /Arbitrum One/, 'FeeCollector Arbitrum')
  const execV2Mainnet = findRow(rows, /^OrderExecutor \(conditional/, /Ethereum Mainnet/, 'OrderExecutor v2 mainnet')
  const execV2Base = findRow(rows, /^OrderExecutor \(conditional/, /Base \(8453\)/, 'OrderExecutor v2 Base')
  const execV3Base = findRow(rows, /OrderExecutor V3/, /Base \(8453\)/, 'OrderExecutor V3 Base')
  const execV3Arb = findRow(rows, /OrderExecutor V3/, /Arbitrum One/, 'OrderExecutor V3 Arbitrum')

  const existing = extractReadmeTableAddresses(readmeMd)
  // The original five-row table must match DEPLOYMENTS exactly — do not "fix"
  // any of those values. After the table is extended, every previously-present
  // address must still appear with the same spelling.
  const originalFive = [
    feeV2Mainnet.address,
    feeBase.address,
    feeArb.address,
    execV2Mainnet.address,
    execV3Base.address,
  ]
  if (existing.addrs.length === 5) {
    for (let i = 0; i < 5; i += 1) {
      process.stdout.write(`length-sentinel existing[${i}] ${existing.addrs[i]} ${existing.addrs[i].length}\n`)
      if (existing.addrs[i] !== originalFive[i]) {
        throw new Error(
          `README existing address ${i} does not match DEPLOYMENTS.md — refusing to alter it.\n` +
            `  README:      ${existing.addrs[i]}\n` +
            `  DEPLOYMENTS: ${originalFive[i]}`,
        )
      }
    }
  } else {
    for (const addr of originalFive) {
      if (!existing.addrs.includes(addr)) {
        throw new Error(`README dropped an existing address ${addr} — refusing to alter it.`)
      }
    }
  }

  const table = [
    '| Contract | Network | Address |',
    '|---|---|---|',
    cell('FeeCollector V2 (instant swaps)', 'Ethereum Mainnet', feeV2Mainnet.address),
    cell('FeeCollector (instant swaps)', 'Base', feeBase.address),
    cell('FeeCollector (instant swaps)', 'Arbitrum One', feeArb.address),
    cell('OrderExecutor v2 (conditional orders)', 'Ethereum Mainnet', execV2Mainnet.address),
    cell('OrderExecutor v2 (conditional orders)', 'Base', execV2Base.address),
    cell('OrderExecutor V3 (conditional orders)', 'Base', execV3Base.address),
    cell('OrderExecutor V3 (conditional orders)', 'Arbitrum One', execV3Arb.address),
  ].join('\n')

  const next = readmeMd.slice(0, existing.start) + table + readmeMd.slice(existing.end)
  if (process.argv.includes('--check')) {
    if (next !== readmeMd) {
      process.stderr.write('README.md contract table is out of sync with docs/DEPLOYMENTS.md\n')
      process.exit(1)
    }
    process.stdout.write('README.md contract table matches docs/DEPLOYMENTS.md\n')
    return
  }
  writeFileSync(README, next)
  process.stdout.write(`wrote ${path.relative(ROOT, README)} (${table.split('\n').length} table lines)\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
