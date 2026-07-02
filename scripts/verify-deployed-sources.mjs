#!/usr/bin/env node
/**
 * [AUDIT-W2 / W2-M-01] Re-verify docs/security/DEPLOYED-SOURCES.md against the chain.
 *
 * For every deployed TeraSwap contract this script:
 *   1. fetches the on-chain runtime bytecode (eth_getCode) on the correct chain,
 *   2. gates its keccak256 8-byte prefix against the pinned baseline (T-SAF W0 /
 *      DEPLOYED-SOURCES.md) — any drift fails,
 *   3. decodes the solc version embedded in the CBOR metadata trailer,
 *   4. byte-compares it against the local `forge build` artifact of the pinned
 *      source — masking immutable references and stripping each side's CBOR
 *      metadata trailer. The compare GATES only rows whose pinned recipe equals
 *      the current foundry settings (`byteGate`); rows deployed from a historical
 *      revision (mainnet OrderExecutor @ c22794c) or with a different recipe
 *      (V1: solc 0.8.20, optimizer off, no via-IR) or pending the Etherscan
 *      verified-settings pull (mainnet FeeCollector V2) report informationally —
 *      see DEPLOYED-SOURCES.md for each row's byte-proof provenance,
 *   5. audits selectors: every selector compiled from the pinned source must
 *      exist in the deployed code (where the artifact matches the deployed
 *      revision), the deployed-only markers must be PRESENT (minimumOutput swap
 *      variants on the FeeCollectors, executeOrder on the OrderExecutors) and
 *      the stale flat's exclusive admin selectors must be ABSENT — the W1-I-02
 *      confusion this file exists to prevent.
 *
 * Run AFTER building the artifacts:
 *   cd contracts && forge build && cd order-engine && forge build && cd ../..
 *   node scripts/verify-deployed-sources.mjs
 *
 * Read-only (public RPCs), no keys, no writes. Exits 1 on any gate failure so it
 * doubles as a manual audit gate. NOT wired into CI (network flakiness) — CI
 * runs the static scripts/check-deployed-sources.mjs instead.
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, http, keccak256 } from 'viem'

const RPCS = {
  1: ['https://ethereum-rpc.publicnode.com'],
  8453: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
}

// The canonical deploy map — MUST mirror docs/security/DEPLOYED-SOURCES.md.
const TARGETS = [
  {
    role: 'FeeCollector V2 (instant swaps)',
    chainId: 1,
    address: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459',
    source: 'contracts/TeraSwapFeeCollector.sol',
    artifact: 'contracts/out/TeraSwapFeeCollector.sol/TeraSwapFeeCollector.json',
    baselineHash: '0x3bde15fc219da158',
    byteGate: false, // Remix deploy — byte-exact repro pending the Etherscan verified-settings pull
    selectorSweep: true,
    expectSelectors: ['7f7663d4', '7739563c'], // swapTokenWithFee/swapETHWithFee (+minimumOutput)
    forbidSelectors: ['33178294'], // old swapTokenWithFee without minimumOutput
    note: 'byte-proof pending Etherscan verified settings (DEPLOYED-SOURCES.md follow-up 1)',
  },
  {
    role: 'FeeCollector (instant swaps)',
    chainId: 8453,
    address: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
    source: 'contracts/TeraSwapFeeCollector.sol',
    artifact: 'contracts/out/TeraSwapFeeCollector.sol/TeraSwapFeeCollector.json',
    baselineHash: '0x2ff08ff8b42c44ba',
    byteGate: true, // byte-proven at current foundry settings (0.8.28, via-IR, 200, cancun)
    selectorSweep: true,
    expectSelectors: ['7f7663d4', '7739563c'],
    forbidSelectors: ['33178294'],
  },
  {
    role: 'FeeCollector V1 (frozen — do not route)',
    chainId: 1,
    address: '0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD',
    source: 'contracts/TeraSwapFeeCollector_flat.sol',
    artifact: 'contracts/out/TeraSwapFeeCollector_flat.sol/TeraSwapFeeCollector.json',
    baselineHash: '0x0462a4dea82127de',
    byteGate: false, // byte-proven with its own recipe: solc 0.8.20, optimizer OFF, no via-IR
    selectorSweep: true,
    expectSelectors: ['33178294'], // V1 predates minimumOutput
    forbidSelectors: ['7f7663d4'],
    note: 'byte-proven 2026-07-02 with recipe solc 0.8.20 / optimizer off / no via-IR',
  },
  {
    role: 'OrderExecutor (conditional orders)',
    chainId: 1,
    address: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
    source: 'contracts/order-engine/TeraSwapOrderExecutor.sol @ c22794c',
    artifact: 'contracts/order-engine/out/TeraSwapOrderExecutor.sol/TeraSwapOrderExecutor.json',
    baselineHash: '0x86c4cf824ab04c2d',
    byteGate: false, // byte-proven at revision c22794c; the CURRENT artifact is the Base revision
    selectorSweep: false, // tip adds timelock/oracle fns that are Base-only by construction
    expectSelectors: ['6233f5c2'], // executeOrder
    forbidSelectors: ['7f7663d4', '7739563c'], // no swap-with-fee fns on the executor
    note: 'byte-proven 2026-07-02 at `git show c22794c:contracts/order-engine/TeraSwapOrderExecutor.sol`',
  },
  {
    role: 'OrderExecutor (conditional orders)',
    chainId: 8453,
    address: '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598',
    source: 'contracts/order-engine/TeraSwapOrderExecutor.sol',
    artifact: 'contracts/order-engine/out/TeraSwapOrderExecutor.sol/TeraSwapOrderExecutor.json',
    baselineHash: '0x34ef10ab25a43c51', // baselined 2026-07-02 (W0 did not hash the Base executor)
    byteGate: true,
    selectorSweep: true,
    expectSelectors: ['6233f5c2'],
    forbidSelectors: ['7f7663d4', '7739563c'],
  },
]

// The stale, never-deployed flat file — its exclusive admin selectors must be
// ABSENT from every deployed FeeCollector (proves the flat is NOT the deployed
// source; they do not exist in contracts/TeraSwapFeeCollector.sol at all).
const STALE_FLAT_ARTIFACT =
  'contracts/out/TeraSwapFeeCollectorV2_DEPRECATED_flat.sol/TeraSwapFeeCollectorV2.json'
const STALE_FLAT_ONLY_SIGNATURES = ['setAllowedSelector(address,bytes4,bool)', 'transferAdmin(address)']

const hex = (s) => (s.startsWith('0x') ? s.slice(2) : s)

async function getCode(chainId, address) {
  let lastErr
  for (const url of RPCS[chainId]) {
    const client = createPublicClient({ transport: http(url) })
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const code = await client.getCode({ address })
        if (code && code !== '0x') return code
        throw new Error('empty code')
      } catch (e) {
        lastErr = e
        await new Promise((r) => setTimeout(r, 800 * attempt))
      }
    }
  }
  throw new Error(`getCode failed for ${address} on chain ${chainId}: ${lastErr?.message}`)
}

/** Decode the solc version from the CBOR metadata trailer (…64736f6c6343 MM mm pp). */
function solcFromTrailer(codeHex) {
  const m = [...hex(codeHex).matchAll(/64736f6c6343([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/g)].pop()
  if (!m) return 'no-cbor-solc'
  return `${parseInt(m[1], 16)}.${parseInt(m[2], 16)}.${parseInt(m[3], 16)}`
}

/** Strip the CBOR metadata trailer (last 2 bytes = its big-endian length). */
function stripMetadata(codeHex) {
  const h = hex(codeHex)
  const bytes = h.length / 2
  if (bytes < 4) return h
  const cborLen = parseInt(h.slice(-4), 16)
  if (cborLen + 2 > bytes || cborLen < 2) return h
  return h.slice(0, (bytes - cborLen - 2) * 2)
}

/** Zero the immutable-reference ranges (offsets are into the DEPLOYED bytecode). */
function maskImmutables(codeHex, immutableReferences) {
  let h = hex(codeHex)
  for (const refs of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of refs) {
      const from = start * 2
      const to = from + length * 2
      if (to <= h.length) h = h.slice(0, from) + '0'.repeat(to - from) + h.slice(to)
    }
  }
  return h
}

function loadArtifact(path) {
  const a = JSON.parse(readFileSync(path, 'utf8'))
  return {
    deployed: a.deployedBytecode?.object ?? '',
    immutables: a.deployedBytecode?.immutableReferences ?? {},
    methodIdentifiers: a.methodIdentifiers ?? {},
    solc: a.metadata?.compiler?.version ?? 'unknown',
  }
}

const selectorInCode = (codeHex, sel) => hex(codeHex).includes(sel.toLowerCase())

let failures = 0
const codeCache = new Map()
const cachedCode = async (chainId, address) => {
  const key = `${chainId}:${address}`
  if (!codeCache.has(key)) codeCache.set(key, await getCode(chainId, address))
  return codeCache.get(key)
}

for (const t of TARGETS) {
  const code = await cachedCode(t.chainId, t.address)
  const fullHash = keccak256(code)
  const prefix = fullHash.slice(0, 18)
  const codeLen = hex(code).length / 2
  const deploySolc = solcFromTrailer(code)

  let byteMatch = 'artifact-missing'
  let artifactSolc = '-'
  const selectorReport = []
  try {
    const art = loadArtifact(t.artifact)
    artifactSolc = art.solc
    const chainStripped = stripMetadata(maskImmutables(code, art.immutables))
    const artStripped = stripMetadata(maskImmutables(art.deployed, art.immutables))
    if (chainStripped === artStripped) {
      byteMatch = 'MATCH (modulo metadata + immutables)'
    } else {
      byteMatch = `differs from CURRENT-settings artifact (chain ${chainStripped.length / 2}B vs artifact ${artStripped.length / 2}B stripped)${t.byteGate ? ' — GATED FAILURE' : ` — expected: ${t.note}`}`
      if (t.byteGate) failures++
    }

    if (t.selectorSweep) {
      const artSelectors = Object.entries(art.methodIdentifiers)
      const missing = artSelectors.filter(([, sel]) => !selectorInCode(code, sel))
      selectorReport.push(
        missing.length === 0
          ? `all ${artSelectors.length} source selectors present on-chain`
          : `MISSING on-chain: ${missing.map(([sig]) => sig).join(', ')}`,
      )
      if (missing.length > 0) failures++
    } else {
      selectorReport.push('full sweep skipped (deployed = historical revision; see note)')
    }
  } catch (e) {
    selectorReport.push(`artifact error: ${e.message}`)
    failures++
  }

  for (const sel of t.expectSelectors) {
    if (!selectorInCode(code, sel)) {
      selectorReport.push(`EXPECTED selector 0x${sel} ABSENT`)
      failures++
    }
  }
  for (const sel of t.forbidSelectors) {
    if (selectorInCode(code, sel)) {
      selectorReport.push(`FORBIDDEN selector 0x${sel} PRESENT`)
      failures++
    }
  }

  const hashVerdict = t.baselineHash === prefix ? 'matches baseline' : `HASH DRIFT (pinned ${t.baselineHash})`
  if (t.baselineHash !== prefix) failures++

  console.log(
    `\n■ ${t.role} — chain ${t.chainId} ${t.address}\n` +
      `  code: ${codeLen} bytes · keccak256 ${fullHash}\n` +
      `  hash prefix ${prefix} (${hashVerdict}) · deployed solc ${deploySolc} · artifact solc ${artifactSolc}\n` +
      `  source ${t.source}\n  byte-compare: ${byteMatch}\n  selectors: ${selectorReport.join(' · ')}`,
  )
}

// Prove the stale flat is not what is deployed: its exclusive admin selectors
// must be absent from both live FeeCollectors.
try {
  const flat = loadArtifact(STALE_FLAT_ARTIFACT)
  const flatOnly = Object.entries(flat.methodIdentifiers).filter(([sig]) =>
    STALE_FLAT_ONLY_SIGNATURES.includes(sig),
  )
  if (flatOnly.length !== STALE_FLAT_ONLY_SIGNATURES.length) {
    console.log(`✗ stale-flat artifact no longer exposes ${STALE_FLAT_ONLY_SIGNATURES.join(', ')}`)
    failures++
  }
  const feeCollectors = [
    { chainId: 1, address: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459' },
    { chainId: 8453, address: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130' },
  ]
  for (const fc of feeCollectors) {
    const code = await cachedCode(fc.chainId, fc.address)
    for (const [sig, sel] of flatOnly) {
      if (selectorInCode(code, sel)) {
        console.log(`✗ stale-flat selector ${sig} (0x${sel}) FOUND on ${fc.chainId}:${fc.address}`)
        failures++
      } else {
        console.log(`✓ stale-flat selector ${sig} (0x${sel}) absent on ${fc.chainId}:${fc.address}`)
      }
    }
  }
} catch {
  console.log('(stale-flat artifact not built — run `cd contracts && forge build` for the flat-only selector probe)')
}

console.log(failures === 0 ? '\nALL DEPLOYED-SOURCES CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
