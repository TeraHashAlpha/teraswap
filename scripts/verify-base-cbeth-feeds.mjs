#!/usr/bin/env node
/**
 * [FIX-CBETH-DIRECT-FEED / 9V-M-01 / INC-2026-08-07-001] Verify Base's three cbETH Chainlink feeds
 * on-chain, and re-derive the DIRECT cbETH/USD proxy from Chainlink's own reference-data directory.
 *
 * THE METHOD IS THE DELIVERABLE — same contract as scripts/verify-arbitrum-addresses.mjs. The
 * incident this closes was caused by a leg with no usable price at signing; the way to reintroduce
 * it is to wire the WRONG feed, and the way that happens is a hand-transcribed address. So no
 * address in the config was typed from a document:
 *
 *   1. RE-DERIVE   — fetch feeds-ethereum-mainnet-base-1.json and take the canonical ENS-named
 *                    `cbeth-usd` entry (NOT a "-svr"/"-shared-svr" sibling, and NOT the
 *                    similarly-named "cbETH-ETH Exchange Rate" entry the 9V audit once matched
 *                    against by mistake).
 *   2. CONFIRM     — read description() / decimals() / latestRoundData() / aggregator() on TWO
 *                    independent Base RPCs, asserting chainId 0x2105 on both (never trust one
 *                    endpoint about chain identity).
 *   3. CROSS-CHECK — assert the directory's proxyAddress equals what the repo registry configures,
 *                    that its aggregator() matches the directory's contractAddress, and that the
 *                    direct USD answer agrees with cbETH/ETH x ETH/USD. Two feeds that were never
 *                    configured to agree, agreeing, is what proves the denomination is right — a
 *                    ~1.14 answer in a USD slot is the original defect's shape.
 *
 * Run: node scripts/verify-base-cbeth-feeds.mjs
 * Read-only (public RPCs + a public JSON file), no keys, no writes on-chain, nothing persisted.
 * NOT wired into CI (network flakiness) — mirrors verify-arbitrum-addresses.mjs's manual/audit-time
 * role. The CI-safe counterparts are the static guards in src/lib/chains/chainlink-feeds.test.ts
 * (identity, USD denomination, heartbeat) and the import-time asserts in chainlink-feeds.ts itself.
 * Exits 1 on any mismatch.
 */
import { encodeFunctionData, decodeFunctionResult } from 'viem'

const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com']
const EXPECTED_CHAIN_ID_HEX = '0x2105' // 8453
const DIRECTORY_URL = 'https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json'

/** The repo's configured values, as the registry states them. Assert-only — never a source. */
const CONFIGURED = {
  // src/lib/chains/chainlink-feeds.ts → PREFERRED_DIRECT_USD_FEEDS_BY_CHAIN[8453]
  directUsd: '0xd7818272B9e248357d13057AAb0B417aF31E817d',
  // → COMPOSED_FEEDS_BY_CHAIN[8453] base / quote
  cbethEth: '0x806b4Ac04501c29769051e42783cF04dCE41440b',
  ethUsd: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  // → EXCHANGE_RATE_PAIRS_BY_CHAIN[8453].exchangeRate (the 9W depeg-breaker leg, deliberately NOT
  //   a swap-price feed — read here only so all three cbETH feeds stay manifested together)
  cbethEthExchangeRate: '0x868a501e68F3D1E89CfC0D22F6b22E8dabce5F04',
}

const AGGREGATOR_ABI = [
  { name: 'description', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'aggregator', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    name: 'latestRoundData', type: 'function', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
]

let failures = 0
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One JSON-RPC call, with backoff on 429. These are free public endpoints and this script issues
 * ~40 reads; without throttling mainnet.base.org rate-limits partway through and the run aborts
 * with a transport error that LOOKS like a verification failure. Retrying transport is safe here —
 * nothing below is retried on a VERIFICATION failure, which still exits 1 immediately.
 */
async function rpc(url, method, params, attempt = 0) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (res.status === 429 && attempt < 5) {
    await sleep(500 * 2 ** attempt)
    return rpc(url, method, params, attempt + 1)
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(`${url}: ${json.error.message}`)
  return json.result
}

async function readFeed(url, address) {
  const call = async (functionName) => {
    const data = encodeFunctionData({ abi: AGGREGATOR_ABI, functionName })
    const result = await rpc(url, 'eth_call', [{ to: address, data }, 'latest'])
    return decodeFunctionResult({ abi: AGGREGATOR_ABI, functionName, data: result })
  }
  // Sequential, not Promise.all: five parallel eth_calls per feed x 8 feed-reads is what trips the
  // public endpoints' rate limit in the first place.
  const code = await rpc(url, 'eth_getCode', [address, 'latest'])
  const description = await call('description')
  const decimals = await call('decimals')
  const aggregator = await call('aggregator')
  const round = await call('latestRoundData')
  {
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = round
    return {
      hasCode: typeof code === 'string' && code.length > 2,
      description, decimals: Number(decimals), aggregator,
      roundId, answer, startedAt: Number(startedAt), updatedAt: Number(updatedAt), answeredInRound,
    }
  }
}

async function main() {
  // ── 1. Chain identity, asserted on BOTH RPCs ──────────────────────────────
  for (const url of RPCS) {
    const id = await rpc(url, 'eth_chainId', [])
    check(id === EXPECTED_CHAIN_ID_HEX, `chainId ${EXPECTED_CHAIN_ID_HEX} on ${url}`, id)
  }
  const blockHex = await rpc(RPCS[0], 'eth_getBlockByNumber', ['latest', false])
  const blockTs = Number(blockHex.timestamp)
  console.log(`\nlatest Base block timestamp: ${blockTs} (${new Date(blockTs * 1000).toISOString()})\n`)

  // ── 2. Re-derive the direct feed from Chainlink's reference-data directory ─
  const directory = await fetch(DIRECTORY_URL).then((r) => {
    if (!r.ok) throw new Error(`directory: HTTP ${r.status}`)
    return r.json()
  })
  const entries = directory.filter((e) => /cbeth/i.test(`${e.name ?? ''} ${e.path ?? ''}`))
  console.log(`directory: ${directory.length} Base feeds, ${entries.length} cbETH entries`)
  for (const e of entries) console.log(`  ${e.path.padEnd(20)} ${e.proxyAddress}  "${e.name}"  ${e.decimals}dp  hb=${e.heartbeat}s`)
  console.log()

  const cbethUsdEntry = entries.find((e) => e.path === 'cbeth-usd')
  check(!!cbethUsdEntry, 'directory has the canonical ENS-named `cbeth-usd` entry')
  if (!cbethUsdEntry) process.exit(1)
  check(
    cbethUsdEntry.proxyAddress.toLowerCase() === CONFIGURED.directUsd.toLowerCase(),
    'directory proxyAddress === the address configured in chainlink-feeds.ts',
    `${cbethUsdEntry.proxyAddress} vs ${CONFIGURED.directUsd}`,
  )
  check(cbethUsdEntry.decimals === 8, 'directory decimals === 8', String(cbethUsdEntry.decimals))
  check(cbethUsdEntry.heartbeat === 1200, 'directory heartbeat === 1200s (matches FEED_HEARTBEAT_SEC)', `${cbethUsdEntry.heartbeat}s`)

  // ── 3. Confirm on-chain, on BOTH RPCs ─────────────────────────────────────
  const TARGETS = [
    { key: 'cbETH/USD (DIRECT, preferred primary)', address: CONFIGURED.directUsd, description: 'CBETH / USD', decimals: 8, maxAgeSec: 1200 * 3 },
    { key: 'cbETH/ETH (composed base, MARKET)', address: CONFIGURED.cbethEth, description: 'CBETH / ETH', decimals: 18, maxAgeSec: 86400 * 2 },
    { key: 'ETH/USD (composed quote)', address: CONFIGURED.ethUsd, description: 'ETH / USD', decimals: 8, maxAgeSec: 1200 * 3 },
    { key: 'cbETH-ETH Exchange Rate (9W depeg leg, NOT a price feed)', address: CONFIGURED.cbethEthExchangeRate, description: 'cbETH-ETH Exchange Rate', decimals: 18, maxAgeSec: 86400 * 2 },
  ]

  const readings = {}
  for (const t of TARGETS) {
    console.log(`\n── ${t.key}\n   ${t.address}`)
    const perRpc = []
    for (const url of RPCS) perRpc.push(await readFeed(url, t.address))
    const [a, b] = perRpc
    check(a.hasCode && b.hasCode, '  eth_getCode non-empty on both RPCs')
    check(a.description === t.description && b.description === t.description, `  description() === "${t.description}"`, `"${a.description}" / "${b.description}"`)
    check(a.decimals === t.decimals && b.decimals === t.decimals, `  decimals() === ${t.decimals}`, `${a.decimals} / ${b.decimals}`)
    check(a.answer > 0n && b.answer > 0n, '  latestRoundData() answer > 0', String(a.answer))
    check(a.answeredInRound >= a.roundId, '  answeredInRound >= roundId (round complete)')
    const age = blockTs - a.updatedAt
    check(age >= 0 && age <= t.maxAgeSec, `  fresh (age <= ${t.maxAgeSec}s)`, `${age}s old`)
    check(a.aggregator.toLowerCase() === b.aggregator.toLowerCase(), '  aggregator() agrees across RPCs', a.aggregator)
    console.log(`   value: ${Number(a.answer) / 10 ** a.decimals}   updatedAt ${a.updatedAt} (${age}s ago)   agg ${a.aggregator}`)
    readings[t.address.toLowerCase()] = a
  }

  const direct = readings[CONFIGURED.directUsd.toLowerCase()]
  check(
    direct.aggregator.toLowerCase() === cbethUsdEntry.contractAddress.toLowerCase(),
    "\naggregator() === the directory's contractAddress (proxy points where the directory says)",
    `${direct.aggregator} vs ${cbethUsdEntry.contractAddress}`,
  )

  // ── 4. Denomination cross-check: direct vs the composition it prefers over ─
  const cbethEth = readings[CONFIGURED.cbethEth.toLowerCase()]
  const ethUsd = readings[CONFIGURED.ethUsd.toLowerCase()]
  const directPrice = Number(direct.answer) / 1e8
  const composedPrice = (Number(cbethEth.answer) / 1e18) * (Number(ethUsd.answer) / 1e8)
  const drift = Math.abs(directPrice - composedPrice) / composedPrice
  console.log(`\ndirect  cbETH/USD = $${directPrice}`)
  console.log(`composed cbETH/ETH x ETH/USD = $${composedPrice.toFixed(6)}`)
  check(drift < 0.01, 'direct and composed agree within 1% (proves USD denomination + scale)', `${(drift * 100).toFixed(4)}% apart`)
  // The magnitude guard, on live data: cbETH is a staking derivative of ETH.
  const ethPrice = Number(ethUsd.answer) / 1e8
  check(directPrice >= ethPrice, 'MAGNITUDE: cbETH/USD >= ETH/USD', `${directPrice} vs ${ethPrice}`)
  check(directPrice <= ethPrice * 2, 'MAGNITUDE: cbETH/USD <= 2x ETH/USD', `ratio ${(directPrice / ethPrice).toFixed(6)}`)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\nverification aborted: ${err.message}`)
  process.exit(1)
})
