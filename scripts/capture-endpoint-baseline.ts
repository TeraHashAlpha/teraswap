#!/usr/bin/env tsx
/**
 * Capture TLS certificate + DNS baseline for all monitored endpoints.
 *
 * Run manually: npm run baseline:capture
 * With force overwrite: npm run baseline:capture -- --force
 * Custom output: npm run baseline:capture -- --output data/baseline-test.json
 *
 * WARNING: Do NOT run before Cloudflare migration is complete.
 * This script captures the current state — run it only when DNS is stable.
 */

import * as tls from 'node:tls'
import * as dns from 'node:dns/promises'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { MONITORED_ENDPOINTS, type MonitoredEndpoint } from '../src/lib/monitored-endpoints'

// ── Types ───────────────────────────────────────────────

interface TLSInfo {
  issuerCN: string
  subjectCN: string
  san: string[]
  fingerprint256: string
}

interface DNSInfo {
  a: string[]
  aaaa: string[]
  ns: string[]
}

interface EndpointBaseline {
  hostname: string
  critical: boolean
  tls: TLSInfo | null
  dns: DNSInfo
  unreachable?: boolean
  error?: string
}

interface BaselineFile {
  generatedAt: string
  endpoints: Record<string, EndpointBaseline>
}

// ── TLS capture ─────────────────────────────────────────

function captureTLS(hostname: string, timeoutMs = 10_000): Promise<TLSInfo | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(443, hostname, { servername: hostname, rejectUnauthorized: false }, () => {
      try {
        const cert = socket.getPeerCertificate(true)
        if (!cert || !cert.fingerprint256) {
          socket.destroy()
          resolve(null)
          return
        }
        const san = cert.subjectaltname
          ? cert.subjectaltname.split(',').map((s: string) => s.trim().replace(/^DNS:/, ''))
          : []
        resolve({
          issuerCN: cert.issuer?.CN || '',
          subjectCN: cert.subject?.CN || '',
          san: san.sort(),
          fingerprint256: cert.fingerprint256,
        })
      } catch {
        resolve(null)
      } finally {
        socket.destroy()
      }
    })
    socket.on('error', () => resolve(null))
    socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve(null) })
  })
}

// ── DNS capture ─────────────────────────────────────────

async function captureDNS(hostname: string): Promise<DNSInfo> {
  const [a, aaaa, ns] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
    dns.resolveNs(hostname).catch(() => {
      // NS records are on the parent domain, try stripping one level
      const parts = hostname.split('.')
      if (parts.length > 2) {
        const parent = parts.slice(-2).join('.')
        return dns.resolveNs(parent).catch(() => [] as string[])
      }
      return [] as string[]
    }),
  ])
  return { a: a.sort(), aaaa: aaaa.sort(), ns: (ns as string[]).sort() }
}

// ── Diff utility ────────────────────────────────────────

function diffBaselines(oldB: BaselineFile, newB: BaselineFile): string[] {
  const diffs: string[] = []
  for (const [id, newData] of Object.entries(newB.endpoints)) {
    const oldData = oldB.endpoints[id]
    if (!oldData) {
      diffs.push(`+ NEW endpoint: ${id} (${newData.hostname})`)
      continue
    }
    // TLS changes
    if (oldData.tls?.fingerprint256 !== newData.tls?.fingerprint256) {
      diffs.push(`~ ${id}: TLS fingerprint changed`)
      diffs.push(`  old: ${oldData.tls?.fingerprint256 || 'none'}`)
      diffs.push(`  new: ${newData.tls?.fingerprint256 || 'none'}`)
    }
    if (oldData.tls?.issuerCN !== newData.tls?.issuerCN) {
      diffs.push(`~ ${id}: TLS issuer changed: ${oldData.tls?.issuerCN} → ${newData.tls?.issuerCN}`)
    }
    // DNS A record changes
    const oldA = JSON.stringify(oldData.dns.a)
    const newA = JSON.stringify(newData.dns.a)
    if (oldA !== newA) {
      diffs.push(`~ ${id}: DNS A records changed: ${oldA} → ${newA}`)
    }
    // DNS NS changes
    const oldNs = JSON.stringify(oldData.dns.ns)
    const newNs = JSON.stringify(newData.dns.ns)
    if (oldNs !== newNs) {
      diffs.push(`~ ${id}: DNS NS records changed: ${oldNs} → ${newNs}`)
    }
  }
  // Removed endpoints
  for (const id of Object.keys(oldB.endpoints)) {
    if (!newB.endpoints[id]) {
      diffs.push(`- REMOVED endpoint: ${id}`)
    }
  }
  return diffs
}

// ── Confirmation prompt ─────────────────────────────────

function askConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y')
    })
  })
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const outputIdx = args.indexOf('--output')
  const outputPath = outputIdx >= 0 && args[outputIdx + 1]
    ? path.resolve(args[outputIdx + 1])
    : path.resolve(process.cwd(), 'data/endpoint-baseline.json')

  console.log(`\n🔍 Capturing TLS + DNS baseline for ${MONITORED_ENDPOINTS.length} endpoints...\n`)

  const baseline: BaselineFile = {
    generatedAt: new Date().toISOString(),
    endpoints: {},
  }

  let captured = 0
  let unreachable = 0

  for (const ep of MONITORED_ENDPOINTS) {
    process.stdout.write(`  ${ep.id.padEnd(15)} (${ep.hostname})... `)

    const [tlsInfo, dnsInfo] = await Promise.all([
      captureTLS(ep.hostname),
      captureDNS(ep.hostname),
    ])

    if (!tlsInfo) {
      console.log('⚠ TLS unreachable')
      baseline.endpoints[ep.id] = {
        hostname: ep.hostname,
        critical: ep.critical,
        tls: null,
        dns: dnsInfo,
        unreachable: true,
        error: 'TLS connection failed or timed out',
      }
      unreachable++
    } else {
      console.log(`✅ ${tlsInfo.issuerCN} | ${dnsInfo.a.length} A records`)
      baseline.endpoints[ep.id] = {
        hostname: ep.hostname,
        critical: ep.critical,
        tls: tlsInfo,
        dns: dnsInfo,
      }
      captured++
    }
  }

  // Summary
  console.log(`\n📊 Summary: ${captured}/${MONITORED_ENDPOINTS.length} captured, ${unreachable} unreachable\n`)

  // Check for existing baseline and show diff
  if (fs.existsSync(outputPath)) {
    try {
      const existing: BaselineFile = JSON.parse(fs.readFileSync(outputPath, 'utf-8'))
      const diffs = diffBaselines(existing, baseline)

      if (diffs.length === 0) {
        console.log('✅ No changes detected from existing baseline.')
        if (!force) {
          console.log('   Use --force to overwrite anyway.\n')
          process.exit(0)
        }
      } else {
        console.log(`⚠ ${diffs.length} difference(s) detected:\n`)
        for (const d of diffs) console.log(`  ${d}`)
        console.log()

        if (!force) {
          const confirmed = await askConfirmation('Overwrite baseline? [y/N] ')
          if (!confirmed) {
            console.log('Aborted.\n')
            process.exit(0)
          }
        }
      }
    } catch {
      console.log('⚠ Existing baseline is corrupt. Will overwrite.')
    }
  }

  // Write
  const dir = path.dirname(outputPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(baseline, null, 2) + '\n')
  console.log(`✅ Baseline written to ${path.relative(process.cwd(), outputPath)}\n`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
