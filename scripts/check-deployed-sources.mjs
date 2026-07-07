#!/usr/bin/env node
/**
 * [AUDIT-W2 / W2-M-01] Static deployed-source-of-truth gate (CI job:
 * deployed-sources-guard). No network, no dependencies — reproducible.
 *
 * Enforces, on every PR:
 *   1. docs/security/DEPLOYED-SOURCES.md exists and still lists every deployed
 *      address (the canonical addr → source → compiler → code-hash map).
 *   2. Every `contracts/….sol` path referenced by the map exists in the repo.
 *   3. The stale, never-deployed FeeCollector flat:
 *      - lives ONLY under the DEPRECATED name (the old name must not reappear),
 *      - still carries its ⛔ DEPRECATED / NOT DEPLOYED banner,
 *      - is never listed as a deployed source in the map section,
 *      - is never referenced by Solidity/TS/JS code (docs/audit history is fine).
 *   4. [CHORE-AZ-SECURITY-BATCH C4] The weak V1 flat (the byte-proven source of
 *      the FROZEN mainnet V1 — 1-arg ctor, no admin/whitelist/timelock/
 *      minimumOutput, open receive()):
 *      - still exists (rule #4 — never delete) and keeps its ⛔ DO NOT DEPLOY
 *        banner,
 *      - is never referenced by Solidity/TS/JS code as a source.
 *   5. contracts/DEPLOY.md prescribes the canonical V2 recipe (source file,
 *      solc 0.8.28, via-IR, 2-arg constructor, DEPLOYED-SOURCES cross-check)
 *      and only ever mentions the V1 flat on a ⛔ warning line — so a stale/
 *      weak deploy target can't slip back into the deploy guide.
 *
 * The on-chain half (hash pin + selector audit + byte-compare) is
 * scripts/verify-deployed-sources.mjs — run manually / per audit, not in CI
 * (public-RPC flakiness).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const failures = []

const DOC = 'docs/security/DEPLOYED-SOURCES.md'
const DEPRECATED_FLAT = 'contracts/TeraSwapFeeCollectorV2_DEPRECATED_flat.sol'
const OLD_FLAT_NAME = 'contracts/TeraSwapFeeCollectorV2_flat.sol'
const BANNER_MARKER = 'DEPRECATED / NOT DEPLOYED'
// [CHORE-AZ-SECURITY-BATCH C4] the weak V1 flat + the deploy guide it must stay out of
const V1_FLAT = 'contracts/TeraSwapFeeCollector_flat.sol'
const V1_BANNER_MARKER = 'DEPRECATED — DO NOT DEPLOY'
const DEPLOY_DOC = 'contracts/DEPLOY.md'
const CANONICAL_SOURCE = 'contracts/TeraSwapFeeCollector.sol'

const DEPLOYED_ADDRESSES = [
  '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459', // FeeCollector V2 (mainnet)
  '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130', // OrderExecutor (mainnet) / FeeCollector (Base)
  '0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD', // FeeCollector V1 (mainnet, frozen)
  '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598', // OrderExecutor (Base)
]

// ── 1+2. The canonical map ─────────────────────────────────────────────────
if (!existsSync(DOC)) {
  failures.push(`${DOC} is missing — the canonical deployed-source map must exist`)
} else {
  const doc = readFileSync(DOC, 'utf8')
  for (const addr of DEPLOYED_ADDRESSES) {
    if (!doc.includes(addr)) failures.push(`${DOC} no longer lists deployed address ${addr}`)
  }
  const referenced = new Set(
    [...doc.matchAll(/`(contracts\/[A-Za-z0-9._/-]+\.sol)`/g)].map((m) => m[1]),
  )
  for (const src of referenced) {
    if (!existsSync(src)) failures.push(`${DOC} references a missing source file: ${src}`)
  }
  // The deployed-map section (before "Sources that are NOT deployed") must never
  // point at a DEPRECATED file.
  const mapSection = doc.split('## Sources that are NOT deployed')[0]
  if (/\bcontracts\/[^\s`]*DEPRECATED[^\s`]*\.sol\b/.test(mapSection)) {
    failures.push(`${DOC} lists a DEPRECATED file as a deployed source`)
  }
}

// ── 3. The stale flat stays deprecated ─────────────────────────────────────
if (existsSync(OLD_FLAT_NAME)) {
  failures.push(`${OLD_FLAT_NAME} reappeared — the stale flat must keep its DEPRECATED name (W2-M-01)`)
}
if (!existsSync(DEPRECATED_FLAT)) {
  failures.push(`${DEPRECATED_FLAT} is missing — never delete it (rule #4), it must stay marked`)
} else if (!readFileSync(DEPRECATED_FLAT, 'utf8').includes(BANNER_MARKER)) {
  failures.push(`${DEPRECATED_FLAT} lost its "${BANNER_MARKER}" banner`)
}

// ── 4. The weak V1 flat stays bannered (deployed-but-frozen; never redeploy) ─
if (!existsSync(V1_FLAT)) {
  failures.push(`${V1_FLAT} is missing — never delete it (rule #4), it is the byte-proven frozen-V1 source`)
} else if (!readFileSync(V1_FLAT, 'utf8').includes(V1_BANNER_MARKER)) {
  failures.push(`${V1_FLAT} lost its "${V1_BANNER_MARKER}" banner`)
}

// ── 5. DEPLOY.md prescribes the canonical V2 recipe, not the weak V1 ────────
if (!existsSync(DEPLOY_DOC)) {
  failures.push(`${DEPLOY_DOC} is missing — the deploy guide must exist and pin the canonical recipe`)
} else {
  const deployDoc = readFileSync(DEPLOY_DOC, 'utf8')
  const requiredMarkers = [
    [CANONICAL_SOURCE, 'the canonical deployable source'],
    ['0.8.28', 'the pinned solc version'],
    ['via-IR', 'the mandatory via-IR compiler setting'],
    ['_admin', 'the 2-arg constructor (_feeRecipient, _admin)'],
    ['DEPLOYED-SOURCES.md', 'the cross-check of the canonical source map'],
  ]
  for (const [marker, what] of requiredMarkers) {
    if (!deployDoc.includes(marker)) {
      failures.push(`${DEPLOY_DOC} no longer mentions "${marker}" (${what}) — the V2 recipe drifted`)
    }
  }
  for (const [i, line] of deployDoc.split('\n').entries()) {
    if (line.includes('TeraSwapFeeCollector_flat') && !line.includes('⛔')) {
      failures.push(
        `${DEPLOY_DOC}:${i + 1} mentions the weak V1 flat without a ⛔ warning — it must never reappear as a deploy target`,
      )
    }
  }
}

// ── 6. Nothing in code references the stale flat as authoritative ──────────
const SKIP_DIRS = new Set(['node_modules', 'out', 'out-mx', 'cache', 'lib', '.git', '.next', '__snapshots__'])
const SELF_ALLOW = new Set([
  'scripts/check-deployed-sources.mjs',
  'scripts/verify-deployed-sources.mjs', // byte-proves the frozen V1 against the flat — the one legit code reference
  DEPRECATED_FLAT,
  V1_FLAT,
])
const CODE_EXT = /\.(sol|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml)$/

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else yield p
  }
}

for (const root of ['contracts', 'src', 'scripts', '.github', 'supabase', 'workers']) {
  if (!existsSync(root)) continue
  for (const file of walk(root)) {
    if (!CODE_EXT.test(file) || SELF_ALLOW.has(file)) continue
    const text = readFileSync(file, 'utf8')
    if (text.includes('TeraSwapFeeCollectorV2_flat') || text.includes('TeraSwapFeeCollectorV2_DEPRECATED_flat')) {
      failures.push(`${file} references the stale flat FeeCollector — it must never be treated as a source`)
    }
    if (text.includes('TeraSwapFeeCollector_flat')) {
      failures.push(`${file} references the weak V1 flat FeeCollector — the only deployable source is ${CANONICAL_SOURCE}`)
    }
  }
}

if (failures.length) {
  console.error('deployed-sources-guard FAILED:')
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(
  'deployed-sources-guard OK — canonical map intact, stale flat stays deprecated, weak V1 flat stays bannered, DEPLOY.md stays on the V2 recipe',
)
