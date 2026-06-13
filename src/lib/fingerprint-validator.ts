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

/**
 * [CHORE-HYGIENE-1 A] Three-way H2 baseline state:
 *  - `ok`               — populated baseline; H2 validates TLS/DNS drift normally.
 *  - `pending-baseline` — the intentional PLACEHOLDER (generatedAt=null and/or 0 endpoints) is
 *                          present. EXPECTED pre-Cloudflare-migration; informational, NON-paging.
 *  - `degraded`         — genuine fault: file missing, unparseable, or malformed (not the known
 *                          placeholder). Stays fail-closed (the PR #177 / P2 behaviour).
 * Investigation (FEEDBACK) confirmed neither non-`ok` state pages today — this distinction is
 * labelling so a known-pending state is never mistaken for a real fault.
 */
export type H2BaselineState = 'ok' | 'pending-baseline' | 'degraded'

let baselineState: H2BaselineState = 'degraded'
let baselineStateReason = ''

/**
 * [CHORE-POLISH-4 P2] True ONLY when the baseline is genuinely populated — a `generatedAt`
 * timestamp AND at least one endpoint. The committed placeholder
 * ({ generatedAt: null, endpoints: {} }) is NOT populated, so H2 must treat it as "validation
 * disabled", never as a healthy pass. Pure (no fs) so the fail-closed contract is testable.
 */
export function isBaselinePopulated(raw: BaselineFile | null | undefined): boolean {
  return !!(raw && raw.generatedAt && raw.endpoints && Object.keys(raw.endpoints).length > 0)
}

/**
 * [CHORE-POLISH-4 P2] Fail-closed H2 baseline health for the monitoring surface. An empty /
 * placeholder baseline reports `healthy: false` with a seeding reason — so a vacuous H2 (which
 * validates nothing) can never report healthy. Pure helper over a given baseline object.
 */
export function evaluateBaselineHealth(raw: BaselineFile | null | undefined): { healthy: boolean; reason: string } {
  if (isBaselinePopulated(raw)) {
    return { healthy: true, reason: `ok: ${Object.keys(raw!.endpoints).length} endpoints (generated ${raw!.generatedAt})` }
  }
  return {
    healthy: false,
    reason:
      'H2 baseline empty/placeholder (generatedAt=null / 0 endpoints) — H2 (TLS+DNS drift) is ' +
      'validating NOTHING. Seed via `npm run baseline:capture` after the Cloudflare migration, ' +
      'review the diff, and commit (ADR-001 §90).',
  }
}

/**
 * [CHORE-HYGIENE-1 A] Pure classifier — maps a baseline-file read result to a 3-way state +
 * reason. Pure (no fs) so every branch is deterministically testable. `raw` is `unknown` because
 * it is untrusted file content; a missing/array/non-object `endpoints` is MALFORMED (a genuine
 * fault), NOT the known placeholder.
 */
export function classifyBaseline(read: { exists: boolean; parseError?: boolean; raw?: unknown }): {
  state: H2BaselineState
  reason: string
} {
  if (!read.exists) {
    return { state: 'degraded', reason: 'H2 baseline file MISSING at data/endpoint-baseline.json — fail-closed (genuine fault: the file should exist).' }
  }
  if (read.parseError) {
    return { state: 'degraded', reason: 'H2 baseline file is UNPARSEABLE (invalid JSON) — fail-closed (genuine fault).' }
  }
  const raw = read.raw
  if (typeof raw !== 'object' || raw === null) {
    return { state: 'degraded', reason: 'H2 baseline is MALFORMED (not a JSON object) — fail-closed (genuine fault), not the known placeholder.' }
  }
  const endpoints = (raw as { endpoints?: unknown }).endpoints
  if (typeof endpoints !== 'object' || endpoints === null || Array.isArray(endpoints)) {
    return { state: 'degraded', reason: 'H2 baseline is MALFORMED (no valid `endpoints` object) — fail-closed (genuine fault), not the known placeholder.' }
  }
  const bf = raw as BaselineFile
  if (isBaselinePopulated(bf)) {
    return { state: 'ok', reason: `ok: ${Object.keys(bf.endpoints).length} endpoints (generated ${bf.generatedAt})` }
  }
  // Valid structure but empty: the intentional placeholder (generatedAt=null and/or 0 endpoints).
  return {
    state: 'pending-baseline',
    reason:
      'H2 baseline is the intentional PLACEHOLDER (generatedAt=null / 0 endpoints) — EXPECTED ' +
      'pre-Cloudflare-migration. NOT a fault and does NOT page; H2 (TLS+DNS drift) is inactive ' +
      'until seeded. Exit pending-baseline by running `npm run baseline:capture` after the ' +
      'migration, reviewing the diff, and committing data/endpoint-baseline.json (ADR-001 §90).',
  }
}

/** [CHORE-HYGIENE-1 A] Current H2 baseline state + reason (reads + classifies the file once, cached). */
export function getBaselineState(): { state: H2BaselineState; reason: string } {
  loadBaseline() // ensures the file is read + the state classified/cached
  return { state: baselineState, reason: baselineStateReason }
}

export function loadBaseline(): BaselineFile | null {
  if (baselineLoaded) return cachedBaseline

  baselineLoaded = true

  // Load + classify baseline (3-way state: ok / pending-baseline / degraded).
  const baselinePath = path.resolve(process.cwd(), 'data/endpoint-baseline.json')
  let read: { exists: boolean; parseError?: boolean; raw?: unknown }
  if (!fs.existsSync(baselinePath)) {
    read = { exists: false }
  } else {
    try {
      read = { exists: true, raw: JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) }
    } catch {
      read = { exists: true, parseError: true }
    }
  }
  const classified = classifyBaseline(read)
  baselineState = classified.state
  baselineStateReason = classified.reason
  if (classified.state === 'ok') {
    cachedBaseline = read.raw as BaselineFile
    console.log(`[H2] Baseline loaded: ${Object.keys(cachedBaseline.endpoints).length} endpoints from ${cachedBaseline.generatedAt}`)
  } else if (classified.state === 'pending-baseline') {
    // EXPECTED, informational — NOT an error, does not page.
    console.info(`[H2] pending-baseline (expected): ${classified.reason}`)
  } else {
    console.warn(`[H2] degraded (fail-closed): ${classified.reason}`)
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
  baselineState = 'degraded'
  baselineStateReason = ''
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
    // codeql[js/disabling-certificate-validation] Intentional: TLS fingerprinting captures the server certificate for pinning — accepting self-signed / untrusted certs at the socket layer is the whole point. The captured fingerprint is then matched against a pinned set in code; we do NOT trust the connection itself for data exchange.
    const socket = tls.connect(443, hostname, { servername: hostname, rejectUnauthorized: false }, () => {
      try {
        const cert = socket.getPeerCertificate(true)
        if (!cert?.fingerprint256) { socket.destroy(); resolve(null); return }
        const san = cert.subjectaltname
          ? cert.subjectaltname.split(',').map((s: string) => s.trim().replace(/^DNS:/, ''))
          : []
        // @types/node 20.19 widened cert.issuer.CN / cert.subject.CN to
        // `string | string[]` (X.509 DNs can carry multiple CN values).
        // We only consume the first/only CN, so coerce defensively.
        const issuerCN = cert.issuer?.CN
        const subjectCN = cert.subject?.CN
        resolve({
          issuerCN: Array.isArray(issuerCN) ? (issuerCN[0] ?? '') : (issuerCN || ''),
          subjectCN: Array.isArray(subjectCN) ? (subjectCN[0] ?? '') : (subjectCN || ''),
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
