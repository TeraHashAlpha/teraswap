#!/usr/bin/env node
/**
 * [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] Verify every CHAIN_CONFIGS[42161] address on-chain and
 * emit a machine-readable manifest. THE METHOD IS THE DELIVERABLE: this script performs the reads
 * and prints the exact address strings — config values are copied from ITS OUTPUT, never retyped by
 * hand. Root cause of the AUDIT-ARBITRUM-46-47 findings was hand-transcribed hex drift (a corrupted
 * variant of a real address, sharing a prefix with the genuine one); this script exists so that
 * failure mode structurally cannot recur.
 *
 * For every address:
 *   - Read from TWO independent Arbitrum RPCs, asserting chainId === 0xa4b1 on both (never trust a
 *     single endpoint; a misconfigured/malicious RPC could lie about chain identity).
 *   - Tokens: eth_getCode non-empty + symbol()/decimals() match the expected values.
 *   - Chainlink price feeds: eth_getCode non-empty + description() contains the claimed pair +
 *     decimals() === 8 + latestRoundData() is fresh (within a generous multiple of the expected
 *     heartbeat) and answer > 0.
 *   - The L2 sequencer-uptime feed: eth_getCode non-empty + description() mentions "Sequencer" +
 *     decimals() === 0 + latestRoundData() answer ∈ {0,1} and startedAt is a sane past timestamp.
 *   - Routers/other contracts (already deep-verified by SPRINT-47-ARBITRUM-ACTIVATION-PREP's
 *     ARBITRUM-ROUTER-VERIFICATION.md): a lighter eth_getCode-only check — this script's job for
 *     these is to MANIFEST them (pin them against silent drift), not re-litigate their verification.
 *
 * Run:
 *   node scripts/verify-arbitrum-addresses.mjs
 * Writes docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json. Exits 1 on any verification failure — no
 * manifest is written on failure, so a broken address can never silently get pinned as "verified".
 * Read-only (public RPCs), no keys, no writes on-chain. NOT wired into CI (network flakiness) —
 * mirrors scripts/verify-deployed-sources.mjs's manual/audit-time role; the CI-safe counterpart is
 * the static guard test (src/lib/chains/arbitrum-manifest.test.ts) that diffs the live config
 * against this script's last emitted manifest.
 */
import { writeFileSync } from 'node:fs'
import { encodeFunctionData, decodeFunctionResult } from 'viem'

const RPCS = ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com']
const EXPECTED_CHAIN_ID_HEX = '0xa4b1' // 42161

const ERC20_ABI = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
]

const AGGREGATOR_ABI = [
  { name: 'description', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    name: 'latestRoundData', type: 'function', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
]

// ── Targets ──────────────────────────────────────────────────────────────
// [CHORE-47B] The 6 dead-address findings: 3 corrupted tokens (USDT/DAI/WBTC), the sequencer feed,
// and — audit correction discovered mid-verification — ALL 5 Chainlink price feeds (ETH/USD and
// USDC/USD were ALSO empty on-chain, not just DAI/USDT/WBTC as the recon summary implied at first
// read; re-checked and confirmed broken before trusting the "only 3" framing).
const TOKENS = [
  { key: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', expectSymbol: 'WETH', expectDecimals: 18, note: 'unchanged — already correct' },
  { key: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', expectSymbol: 'USDC', expectDecimals: 6, note: 'unchanged — already correct (native USDC)' },
  { key: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', expectSymbol: null, expectDecimals: 6, note: 'CORRECTED — see FEEDBACK: on-chain symbol() is "USD₮0" (Tether\'s LayerZero omnichain standard), the dominant USDT-pegged token on Arbitrum by trading volume today (GeckoTerminal top-pool cross-check); config key stays USDT for continuity with the rest of the codebase' },
  { key: 'DAI', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', expectSymbol: 'DAI', expectDecimals: 18, note: 'CORRECTED — old value had zero on-chain code' },
  { key: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', expectSymbol: 'WBTC', expectDecimals: 8, note: 'CORRECTED — old value had zero on-chain code' },
]

const FEEDS = [
  { key: 'ETH/USD', address: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', pairSubstr: 'ETH / USD', note: 'CORRECTED — old value had zero on-chain code' },
  { key: 'USDC/USD', address: '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3', pairSubstr: 'USDC / USD', note: 'CORRECTED — old value had zero on-chain code' },
  { key: 'DAI/USD', address: '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB', pairSubstr: 'DAI / USD', note: 'CORRECTED — old value had zero on-chain code' },
  { key: 'USDT/USD', address: '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7', pairSubstr: 'USDT / USD', note: 'CORRECTED — old value had zero on-chain code' },
  { key: 'WBTC/USD', address: '0xd0C7101eACbB49F3deCcCc166d238410D6D46d57', pairSubstr: 'WBTC / USD', note: 'CORRECTED — old value had zero on-chain code' },
]

const SEQUENCER = {
  key: 'sequencerUptimeFeed',
  address: '0xFdB631F5EE196F0ed6FAa767959853A9F217697D',
  note: 'CORRECTED — old value had zero on-chain code',
}

// Already deep-verified in ARBITRUM-ROUTER-VERIFICATION.md (bytecode diffs / live adapter API
// calls) — manifested here as-is per the spec ("do NOT change any audit-validated router/adapter
// value"). Lighter check: eth_getCode presence only.
const OTHER_CONTRACTS = [
  { key: 'permit2', address: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
  { key: 'cowVaultRelayer', address: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' },
  { key: 'router:1inch', address: '0x111111125421cA6dc452d289314280a0f8842A65' },
  { key: 'router:0x', address: '0x0000000000001fF3684f28c67538d4D072C22734' },
  { key: 'router:velora', address: '0x6A000F20005980200259B80c5102003040001068' },
  { key: 'router:odos', address: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1' },
  { key: 'router:kyberswap', address: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' },
  { key: 'router:openocean', address: '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64' },
  { key: 'router:sushiswap', address: '0xAC4c6e212A361c968F1725b4d055b47E63F80b75' },
  { key: 'router:balancer', address: '0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  { key: 'router:uniswapv3', address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' },
  { key: 'uniswapV3:factory', address: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
  { key: 'uniswapV3:quoterV2', address: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' },
]

// ── RPC helpers ──────────────────────────────────────────────────────────
async function rpcCall(rpc, method, params) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(JSON.stringify(json.error))
  return json.result
}

const getChainId = (rpc) => rpcCall(rpc, 'eth_chainId', [])
const getBlockNumber = (rpc) => rpcCall(rpc, 'eth_blockNumber', [])
const getCode = (rpc, address) => rpcCall(rpc, 'eth_getCode', [address, 'latest'])
const ethCall = (rpc, to, data) => rpcCall(rpc, 'eth_call', [{ to, data }, 'latest'])

async function readContract(rpc, address, abi, functionName) {
  const data = encodeFunctionData({ abi, functionName })
  const result = await ethCall(rpc, address, data)
  return decodeFunctionResult({ abi, functionName, data: result })
}

// ── Verification ─────────────────────────────────────────────────────────
const manifest = { generatedAt: new Date().toISOString(), rpcs: RPCS, entries: [] }
let failures = 0

function report(category, key, address, ok, detail, extra = {}) {
  console.log(`${ok ? '✓' : '✗'} [${category}] ${key} ${address} — ${detail}`)
  if (!ok) failures++
  manifest.entries.push({ category, key, address, ok, detail, ...extra })
}

async function main() {
  // ── Chain identity, asserted on BOTH RPCs ──
  const blocks = {}
  for (const rpc of RPCS) {
    const cid = await getChainId(rpc)
    if (cid !== EXPECTED_CHAIN_ID_HEX) {
      console.error(`FATAL: ${rpc} reports chainId ${cid}, expected ${EXPECTED_CHAIN_ID_HEX} (42161)`)
      process.exit(1)
    }
    blocks[rpc] = await getBlockNumber(rpc)
  }
  manifest.blocks = blocks
  console.log(`chainId 0xa4b1 confirmed on both RPCs. Blocks: ${JSON.stringify(blocks)}\n`)

  // ── Tokens: eth_getCode + symbol()/decimals() on both RPCs ──
  for (const t of TOKENS) {
    let ok = true
    const perRpc = []
    for (const rpc of RPCS) {
      const code = await getCode(rpc, t.address)
      const codeOk = code && code !== '0x'
      let symbol = null, decimals = null
      if (codeOk) {
        try { symbol = await readContract(rpc, t.address, ERC20_ABI, 'symbol') } catch { /* some tokens revert on odd bytes32 symbol — non-fatal below */ }
        try { decimals = await readContract(rpc, t.address, ERC20_ABI, 'decimals') } catch { decimals = null }
      }
      const decOk = decimals === t.expectDecimals
      const symOk = t.expectSymbol === null || symbol === t.expectSymbol
      perRpc.push({ rpc, codeLen: code?.length ?? 0, symbol, decimals })
      ok = ok && codeOk && decOk && symOk
    }
    report('token', t.key, t.address, ok, `symbol/decimals match on both RPCs (${t.note})`, { perRpc, expectDecimals: t.expectDecimals, expectSymbol: t.expectSymbol })
  }

  // ── Chainlink price feeds: eth_getCode + description()/decimals()/freshness on both RPCs ──
  for (const f of FEEDS) {
    let ok = true
    const perRpc = []
    for (const rpc of RPCS) {
      const code = await getCode(rpc, f.address)
      const codeOk = code && code !== '0x'
      let description = null, decimals = null, answer = null, updatedAt = null
      if (codeOk) {
        try { description = await readContract(rpc, f.address, AGGREGATOR_ABI, 'description') } catch { /* ok=false below */ }
        try { decimals = await readContract(rpc, f.address, AGGREGATOR_ABI, 'decimals') } catch { /* ok=false below */ }
        try {
          const rd = await readContract(rpc, f.address, AGGREGATOR_ABI, 'latestRoundData')
          answer = rd[1].toString()
          updatedAt = Number(rd[3])
        } catch { /* ok=false below */ }
      }
      const descOk = description === f.pairSubstr
      const decOk = decimals === 8
      const answerOk = answer !== null && BigInt(answer) > 0n
      const freshOk = updatedAt !== null && (Date.now() / 1000 - updatedAt) < 172800 // 48h — generous vs any of these feeds' heartbeats
      perRpc.push({ rpc, codeLen: code?.length ?? 0, description, decimals, answer, updatedAt })
      ok = ok && codeOk && descOk && decOk && answerOk && freshOk
    }
    report('feed', f.key, f.address, ok, `description="${f.pairSubstr}", decimals=8, fresh, answer>0 on both RPCs (${f.note})`, { perRpc })
  }

  // ── Sequencer uptime feed: eth_getCode + description()/decimals()/uptime-semantics ──
  {
    let ok = true
    const perRpc = []
    for (const rpc of RPCS) {
      const code = await getCode(rpc, SEQUENCER.address)
      const codeOk = code && code !== '0x'
      let description = null, decimals = null, answer = null, startedAt = null
      if (codeOk) {
        try { description = await readContract(rpc, SEQUENCER.address, AGGREGATOR_ABI, 'description') } catch { /* ok=false below */ }
        try { decimals = await readContract(rpc, SEQUENCER.address, AGGREGATOR_ABI, 'decimals') } catch { /* ok=false below */ }
        try {
          const rd = await readContract(rpc, SEQUENCER.address, AGGREGATOR_ABI, 'latestRoundData')
          answer = rd[1].toString()
          startedAt = Number(rd[2])
        } catch { /* ok=false below */ }
      }
      const descOk = typeof description === 'string' && /sequencer/i.test(description)
      const decOk = decimals === 0
      const answerOk = answer === '0' || answer === '1'
      const startedAtOk = startedAt !== null && startedAt > 0 && startedAt <= Date.now() / 1000
      perRpc.push({ rpc, codeLen: code?.length ?? 0, description, decimals, answer, startedAt })
      ok = ok && codeOk && descOk && decOk && answerOk && startedAtOk
    }
    report('sequencer', SEQUENCER.key, SEQUENCER.address, ok, `description mentions "Sequencer", decimals=0, answer∈{0,1}, startedAt sane on both RPCs (${SEQUENCER.note})`, { perRpc })
  }

  // ── Other contracts (routers etc.) — lighter check, already deep-verified by #303 ──
  for (const c of OTHER_CONTRACTS) {
    let ok = true
    const perRpc = []
    for (const rpc of RPCS) {
      const code = await getCode(rpc, c.address)
      const codeOk = code && code !== '0x'
      perRpc.push({ rpc, codeLen: code?.length ?? 0 })
      ok = ok && codeOk
    }
    report('contract', c.key, c.address, ok, 'eth_getCode non-empty on both RPCs (deep-verified in ARBITRUM-ROUTER-VERIFICATION.md — manifested as-is)', { perRpc })
  }

  console.log(`\n${manifest.entries.length} entries checked, ${failures} failure(s).`)
  if (failures === 0) {
    writeFileSync('docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json', JSON.stringify(manifest, null, 2) + '\n')
    console.log('Wrote docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json')
  } else {
    console.error('NOT writing the manifest — fix the failing entries first.')
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
