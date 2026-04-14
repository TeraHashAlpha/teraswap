/**
 * TLS + DNS baseline comparison for monitored endpoints.
 *
 * Compares live observations against committed baseline
 * (data/endpoint-baseline.json). Mismatches trigger P0 alerts.
 *
 * Key design: Let's Encrypt renewals (same issuer, new fingerprint,
 * same hostname in SAN) are NOT flagged. Only issuer changes,
 * missing SAN entries, or NS record changes are P0.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as dns from 'node:dns/promises'
import * as tls from 'node:tls'
import { MONITORED_ENDPOINTS } from './monitored-endpoints'

// ── Types ───────────────────────────────────────────────

interface TLSBaseline {
  issuerCN: string
  subjectCN: string
  san: string[]
  fingerprint256: string
}

interface DNSBaseline {
  a: string[]
  aaaa: string[]
  ns: string[]
}

interface EndpointBaseline {
  hostname: string
  critical: boolean
  tls: TLSBaseline | null
  dns: DNSBaseline
  unreachable?: boolean
}

interface BaselineFile {
  generatedAt: string | null
  endpoints: Record<string, EndpointBaseline>
}

interface OverrideEntry {
  ignoreFingerprintMismatch?: boolean
  ignoreDnsMismatch?: boolean
}

interface ValidationResult {
  ok: boolean
  reason?: string
}

// ── Baseline cache ──────────────────────────────────────

let cachedBaseline: BaselineFile | null = null
let cachedOverrides: Record<string, OverrideEntry> = {}
let baselineLoaded = false

export function loadBaseline(): BaselineFile | null {
  if (baselineLoaded) return cachedBaseline

  baselineLoaded = true

  // Load baseline
  try {
    const baselinePath = path.resolve(process.cwd(), 'data/endpoint-baseline.json')
    if (fs.existsSync(baselinePath)) {
      const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as BaselineFile
      if (raw.generatedAt && Object.keys(raw.endpoints).length > 0) {
        cachedBaseline = raw
        console.log(`[H2] Baseline loaded: ${Object.keys(raw.endpoints).length} endpoints from ${raw.generatedAt}`)
      } else {
        console.warn('[H2] Baseline file exists but is empty/placeholder — H2 validation disabled')
      }
    } else {
      console.warn('[H2] No baseline file at data/endpoint-baseline.json — H2 validation disabled')
    }
  } catch (err) {
    console.warn('[H2] Failed to load baseline:', err)
  }

  // Load overrides (optional)
  try {
    const overridePath = path.resolve(process.cwd(), 'data/endpoint-baseline-overrides.json')
    if (fs.existsSync(overridePath)) {
      cachedOverrides = JSON.parse(fs.readFileSync(overridePath, 'utf-8'))
      console.log(`[H2] Overrides loaded: ${Object.keys(cachedOverrides).length} entries`)
    }
  } catch {
    // No overrides file — that's fine
  }

  return cachedBaseline
}

/** Force reload (for testing) */
export function resetBaseline(): void {
  cachedBaseline = null
  cachedOverrides = {}
  baselineLoaded = false
}

// ── TLS validation ──────────────────────────────────────

export function validateTLS(
  endpointId: string,
  observedCert: { issuerCN: string; subjectCN: string; san: string[]; fingerprint256: string },
): ValidationResult {
  const baseline = loadBaseline()
  if (!baseline) return { ok: true } // No baseline → skip validation

  const entry = baseline.endpoints[endpointId]
  if (!entry?.tls) return { ok: true } // No TLS baseline for this endpoint

  // Check override
  const override = cachedOverrides[endpointId]
  if (override?.ignoreFingerprintMismatch) {
    console.log(`[H2] ${endpointId}: fingerprint override active — skipping TLS validation`)
    return { ok: true, reason: 'override-active' }
  }

  const expected = entry.tls
  const hostname = entry.hostname

  // Rule 1: Issuer CN matches expected + hostname in SAN → OK (covers LE renewal)
  const expectedEndpoint = MONITORED_ENDPOINTS.find(e => e.id === endpointId)
  const expectedIssuerCN = expectedEndpoint?.expectedIssuerCN || expected.issuerCN

  if (observedCert.issuerCN === expectedIssuerCN) {
    // Same issuer — check hostname is in SAN (prevents cert for wrong domain)
    const hostnameInSAN = observedCert.san.some(
      s => s === hostname || s === `*.${hostname.split('.').slice(1).join('.')}`
    )
    if (hostnameInSAN) {
      // Rule 1 passes: same issuer, hostname covered by SAN
      // Fingerprint may differ (normal renewal) — that's OK
      return { ok: true }
    }
  }

  // Rule 2: Exact fingerprint match → OK
  if (observedCert.fingerprint256 === expected.fingerprint256) {
    return { ok: true }
  }

  // Rule 3: Mismatch — build descriptive reason
  const reasons: string[] = []
  if (observedCert.issuerCN !== expectedIssuerCN) {
    reasons.push(`Issuer changed: expected '${expectedIssuerCN}', got '${observedCert.issuerCN}'`)
  }
  if (observedCert.fingerprint256 !== expected.fingerprint256) {
    reasons.push(`Fingerprint changed: ${expected.fingerprint256.slice(0, 20)}... → ${observedCert.fingerprint256.slice(0, 20)}...`)
  }
  const hostnameInSAN = observedCert.san.some(
    s => s === hostname || s === `*.${hostname.split('.').slice(1).join('.')}`
  )
  if (!hostnameInSAN) {
    reasons.push(`Hostname '${hostname}' not found in SAN: [${observedCert.san.slice(0, 3).join(', ')}${observedCert.san.length > 3 ? '...' : ''}]`)
  }

  return { ok: false, reason: reasons.join('; ') }
}

// ── DNS validation ──────────────────────────────────────

export function validateDNS(
  endpointId: string,
  observed: { a: string[]; aaaa: string[]; ns: string[] },
): ValidationResult {
  const baseline = loadBaseline()
  if (!baseline) return { ok: true }

  const entry = baseline.endpoints[endpointId]
  if (!entry?.dns) return { ok: true }

  // Check override
  const override = cachedOverrides[endpointId]
  if (override?.ignoreDnsMismatch) {
    console.log(`[H2] ${endpointId}: DNS override active — skipping validation`)
    return { ok: true, reason: 'override-active' }
  }

  const expected = entry.dns

  // A/AAAA: require non-empty intersection (cloud providers rotate IPs)
  if (expected.a.length > 0 && observed.a.length > 0) {
    const intersection = observed.a.filter(ip => expected.a.includes(ip))
    if (intersection.length === 0) {
      return {
        ok: false,
        reason: `All A records replaced: baseline [${expected.a.join(', ')}] → observed [${observed.a.join(', ')}]`,
      }
    }
  }

  // NS: must match exactly (NS changes are always suspicious)
  if (expected.ns.length > 0 && observed.ns.length > 0) {
    const expectedSorted = [...expected.ns].sort().join(',')
    const observedSorted = [...observed.ns].sort().join(',')
    if (expectedSorted !== observedSorted) {
      return {
        ok: false,
        reason: `NS records changed: baseline [${expected.ns.join(', ')}] → observed [${observed.ns.join(', ')}]`,
      }
    }
  }

  return { ok: true }
}

// ── Live TLS capture (lightweight) ──────────────────────

export function captureLiveTLS(
  hostname: string,
  timeoutMs = 8_000,
): Promise<{ issuerCN: string; subjectCN: string; san: string[]; fingerprint256: string } | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(443, hostname, { servername: hostname, rejectUnauthorized: false }, () => {
      try {
        const cert = socket.getPeerCertificate(true)
        if (!cert?.fingerprint256) { socket.destroy(); resolve(null); return }
        const san = cert.subjectaltname
          ? cert.subjectaltname.split(',').map((s: string) => s.trim().replace(/^DNS:/, ''))
          : []
        resolve({
          issuerCN: cert.issuer?.CN || '',
          subjectCN: cert.subject?.CN || '',
          san: san.sort(),
          fingerprint256: cert.fingerprint256,
        })
      } catch { resolve(null) }
      finally { socket.destroy() }
    })
    socket.on('error', () => resolve(null))
    socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve(null) })
  })
}

// ── Live DNS capture (lightweight) ──────────────────────

export async function captureLiveDNS(hostname: string): Promise<{ a: string[]; aaaa: string[]; ns: string[] }> {
  const [a, aaaa, ns] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
    dns.resolveNs(hostname).catch(() => {
      const parts = hostname.split('.')
      if (parts.length > 2) return dns.resolveNs(parts.slice(-2).join('.')).catch(() => [] as string[])
      return [] as string[]
    }),
  ])
  return { a: a.sort(), aaaa: aaaa.sort(), ns: (ns as string[]).sort() }
}
