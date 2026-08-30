#!/usr/bin/env node
/**
 * Fail CI when a user-facing surface hard-codes a source count or a
 * live-status chain name instead of importing src/config/product-claims.ts.
 *
 * The claims module derives:
 *   (a) ADAPTER_REGISTRY.length
 *   (b) the chain registry
 *   (c) each order type's launch flag
 *
 * A file scan of adapter filenames is not an acceptable substitute for (a).
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const USER_FACING_FILES = Object.freeze([
  'src/app/layout.tsx',
  'src/app/swap/page.tsx',
  'src/app/app/route.ts',
  'src/components/LandingPage.tsx',
  'src/components/LandingBelowFold.tsx',
  'src/components/DocsPage.tsx',
  'src/components/SwapBox.tsx',
  'src/components/DCAPanel.tsx',
])

const SPELLED =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen'

// 1–99 or a spelled small number. Three-digit figures (e.g. 1inch "400+
// liquidity sources") are other products' pool counts, not TeraSwap's source claim.
const COUNT = String.raw`(?:[1-9]\d?|${SPELLED})`

/** Digit or spelled number sitting next to source(s) / DEX. */
export const SOURCE_CLAIM_RE = new RegExp(
  String.raw`\b${COUNT}\s+(?:(?:independent|integrated|liquidity|DEX)\s+)*sources?\b|\b${COUNT}\s+DEX\b|\b${COUNT}\s+Liquidity Sources\b|\b${COUNT}\b[^.\n]{0,80}LIQUIDITY SOURCES`,
  'gi',
)

const CHAIN = String.raw`ethereum(?:\s+mainnet)?|base|arbitrum(?:\s+one)?`

/** Chain named as a live-status claim, not as a technical deployment note. */
export const LIVE_STATUS_RE = new RegExp(
  String.raw`\blive\s+on\s+(?:${CHAIN})\b|\bDCA\s+live\b|\bDCA\s+is\s+\*\*live|Non-custodial\s*·\s*Ethereum Mainnet|>Ethereum Mainnet<`,
  'gi',
)

export const PRODUCT_CLAIMS_IMPORT_RE = /from\s+['"]@\/config\/product-claims['"]/

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length
}

function collect(re, content, kind) {
  const hits = []
  const copy = new RegExp(re.source, re.flags)
  let m
  while ((m = copy.exec(content)) !== null) {
    hits.push({
      kind,
      match: m[0].replace(/\s+/g, ' ').trim(),
      line: lineNumberAt(content, m.index),
    })
    if (m.index === copy.lastIndex) copy.lastIndex += 1
  }
  return hits
}

export function findViolations(content) {
  return [
    ...collect(SOURCE_CLAIM_RE, content, 'hard-coded source count'),
    ...collect(LIVE_STATUS_RE, content, 'hard-coded live-status chain'),
  ]
}

export function checkContent(content, filename) {
  const violations = findViolations(content)
  const imported = PRODUCT_CLAIMS_IMPORT_RE.test(content)
  return { filename, imported, violations }
}

export function checkFiles(root = ROOT, files = USER_FACING_FILES) {
  const results = []
  for (const rel of files) {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) {
      results.push({
        filename: rel,
        imported: false,
        violations: [{ kind: 'missing file', match: rel, line: 0 }],
      })
      continue
    }
    results.push(checkContent(readFileSync(abs, 'utf8'), rel))
  }
  return results
}

export function formatReport(results) {
  const lines = []
  let failed = 0
  for (const r of results) {
    if (r.violations.length === 0) continue
    failed += r.violations.length
    for (const v of r.violations) {
      lines.push(`${r.filename}:${v.line}: ${v.kind}: "${v.match}"`)
    }
    if (!r.imported && r.violations.some((v) => v.kind !== 'missing file')) {
      lines.push(`${r.filename}: also missing import of @/config/product-claims`)
    }
  }
  return { failed, text: lines.join('\n') }
}

export function runCheck(root = ROOT, files = USER_FACING_FILES) {
  const results = checkFiles(root, files)
  const { failed, text } = formatReport(results)
  if (failed > 0) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `product-claims check failed (${failed} hard-coded claim(s)):\n${text}\n`,
    }
  }
  const scanned = results.length
  const imported = results.filter((r) => r.imported).length
  return {
    ok: true,
    code: 0,
    stdout: `product-claims check passed: ${scanned} user-facing file(s), ${imported} import the claims module, 0 hard-coded source/chain claims.\n`,
    stderr: '',
  }
}

function parseArgs(argv) {
  const files = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file' && argv[i + 1]) {
      files.push(argv[i + 1])
      i += 1
    } else if (!argv[i].startsWith('-')) {
      files.push(argv[i])
    }
  }
  return files
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const extra = parseArgs(process.argv.slice(2))
  const result = extra.length > 0 ? runCheck(ROOT, extra) : runCheck()
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.code)
}
