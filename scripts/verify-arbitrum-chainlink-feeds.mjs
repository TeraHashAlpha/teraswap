#!/usr/bin/env node
/**
 * [FIX-ARBITRUM-FEED-VERIFICATION] Re-verify the five Arbitrum (42161) Chainlink PRICE feeds
 * on-chain, now that they are load-bearing.
 *
 * WHY AGAIN. These five were verified once (CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION) under the
 * belief that the 42161 block was dark — `contracts.feeCollector` was null, so
 * `isChainActive(42161)` was false and nothing could reach them. That premise no longer holds:
 * registry.ts resolves the FeeCollector from `process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR`, and
 * that variable IS set in Vercel Production. These feeds gate real swaps today, so they are
 * re-verified as live infrastructure rather than as inert config.
 *
 * THE METHOD IS THE DELIVERABLE — and the method's first rule is that no hex is ever retyped:
 *   - Every address is parsed PROGRAMMATICALLY out of src/lib/chains/chainlink-feeds.ts. Nothing
 *     here is transcribed by hand, because hand-transcribed hex is precisely what caused
 *     AUDIT-ARBITRUM-46-47 (all 5 recon-sourced feed addresses had ZERO on-chain code, each
 *     sharing a prefix with the real feed and diverging after it).
 *   - Every comparison is COMPUTED and lower-cased, never eyeballed. A prefix-sharing address is
 *     indistinguishable from the real one at a glance; that is the whole failure mode.
 *   - The pair each feed is CLAIMED to be is read from the file's own FEED_EXPECTATIONS block
 *     (ADR-018), so identity is checked against the config's own declaration rather than against
 *     an expectation restated here.
 *
 * Per feed, on TWO INDEPENDENT public RPCs (no API keys, no .env, read-only):
 *   - eth_getCode          — bytecode MUST be non-empty. This is the exact check the earlier
 *                            incident failed: a dead address reverts every call, so every other
 *                            check is vacuous until this one passes.
 *   - description()        — must equal the FEED_EXPECTATIONS pair (ADR-018 identity).
 *   - decimals()           — must equal the FEED_EXPECTATIONS decimals.
 *   - latestRoundData()    — answer scaled to human units + round age.
 *   - aggregator()         — the proxy's current implementation, pinned for drift detection.
 * Both RPCs must agree on chainId (a misconfigured or hostile endpoint could lie about which
 * chain it is serving) and on every identity field.
 *
 * Three independent sanity checks the readings must survive (a feed can pass identity and still
 * be wrong — a denomination error passes description() and fails magnitude):
 *   1. IDENTITY  — description() == the claimed pair, for all five.
 *   2. MAGNITUDE — stablecoins within 2% of $1.00; WBTC/USD >= 5x ETH/USD; Arbitrum ETH/USD
 *                  within 20% of the BASE ETH/USD feed (itself parsed from the 8453 block and
 *                  read on two independent Base RPCs — an independent chain as the anchor).
 *   3. FRESHNESS — each round's age against that feed's own heartbeat (FEED_HEARTBEAT_SEC) and
 *                  the codebase's heartbeat x 1.5 staleness ceiling. REPORTED, not judged.
 *
 * Run:  node scripts/verify-arbitrum-chainlink-feeds.mjs
 * Read-only. Exits 1 if any feed has no code, fails identity, or the RPCs disagree.
 * NOT wired into CI (public-RPC flakiness) — same manual/audit-time role as
 * scripts/verify-arbitrum-addresses.mjs and scripts/verify-base-cbeth-feeds.mjs.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { encodeFunctionData, decodeFunctionResult } from 'viem'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = join(here, '..')
const FEEDS_TS = join(REPO, 'src', 'lib', 'chains', 'chainlink-feeds.ts')

const ARB = { name: 'Arbitrum One', chainId: 42161, idHex: '0xa4b1',
  rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'] }
const BASE = { name: 'Base', chainId: 8453, idHex: '0x2105',
  rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] }

/** The five pairs the 42161 block is required to carry. Used only to assert the CONFIG declares
 *  what it is supposed to declare — the per-feed identity check compares on-chain description()
 *  against FEED_EXPECTATIONS, i.e. against the file itself, not against this list. */
const REQUIRED_PAIRS = ['ETH / USD', 'USDC / USD', 'DAI / USD', 'USDT / USD', 'WBTC / USD']
const STABLE_PAIRS = new Set(['USDC / USD', 'DAI / USD', 'USDT / USD'])

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

// ── Source parsing (no hand-typed hex) ───────────────────────────────────────────────────────

const SRC = readFileSync(FEEDS_TS, 'utf8')

/**
 * Body of the first `{...}` after `opener`, matched by brace depth.
 *
 * The start brace deliberately SKIPS any `{` preceded by `$`: these declarations are typed
 * ``Record<number, Record<string, `0x${string}`>>``, and the `{` inside that template-literal type
 * would otherwise be mistaken for the object literal's opening brace (it was — the first run of
 * this script returned an empty body and could not find `42161:`).
 */
function blockAfter(source, opener) {
  const at = source.indexOf(opener)
  if (at === -1) throw new Error(`parse: opener not found: ${opener}`)
  let open = -1
  for (let i = at; i < source.length; i++) {
    if (source[i] === '{' && source[i - 1] !== '$') { open = i; break }
  }
  if (open === -1) throw new Error(`parse: no object-literal "{" after: ${opener}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i)
  }
  throw new Error(`parse: unbalanced braces after: ${opener}`)
}

/** Strip `//` line comments. Safe for the address-map blocks (they contain no `://` in strings). */
const stripComments = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')

/** All `'0x<token>': '0x<feed>'` pairs in a map block. */
function parseTokenFeedPairs(block) {
  const out = []
  const RE = /'(0x[0-9a-fA-F]{40})'\s*:\s*'(0x[0-9a-fA-F]{40})'/g
  for (const m of stripComments(block).matchAll(RE)) out.push({ token: m[1], feed: m[2] })
  return out
}

const feedsByChain = blockAfter(SRC, 'export const CHAINLINK_FEEDS_BY_CHAIN: Record')
const arbPairs = parseTokenFeedPairs(blockAfter(feedsByChain, '42161:'))
const basePairs = parseTokenFeedPairs(blockAfter(feedsByChain, '8453:'))

/** FEED_EXPECTATIONS: feed address (lowercased) -> { description, decimals } — ADR-018 identity. */
const EXPECTATIONS = new Map()
{
  const block = blockAfter(SRC, 'const FEED_EXPECTATIONS: Record')
  const RE = /'(0x[0-9a-fA-F]{40})'\s*:\s*\{\s*description:\s*'([^']*)'\s*,\s*decimals:\s*(\d+)\s*\}/g
  for (const m of block.matchAll(RE)) {
    EXPECTATIONS.set(m[1].toLowerCase(), { description: m[2], decimals: Number(m[3]) })
  }
}

/** FEED_HEARTBEAT_SEC: feed address (lowercased) -> heartbeat seconds. */
const HEARTBEATS = new Map()
{
  const block = blockAfter(SRC, 'const FEED_HEARTBEAT_SEC: Record')
  const RE = /'(0x[0-9a-fA-F]{40})'\s*:\s*(\d+)/g
  for (const m of stripComments(block).matchAll(RE)) HEARTBEATS.set(m[1].toLowerCase(), Number(m[2]))
}

if (arbPairs.length !== 5) {
  throw new Error(`parse: expected 5 Arbitrum feeds, parsed ${arbPairs.length} — parser drifted from the source`)
}

/** Attach each feed's CLAIMED identity, from the file's own FEED_EXPECTATIONS. */
const arbTargets = arbPairs.map(({ token, feed }) => {
  const exp = EXPECTATIONS.get(feed.toLowerCase())
  if (!exp) throw new Error(`config: feed ${feed} has no FEED_EXPECTATIONS entry (ADR-018 fails closed)`)
  return { token, feed, claimed: exp.description, claimedDecimals: exp.decimals,
           heartbeat: HEARTBEATS.get(feed.toLowerCase()) ?? null }
})

// The config must declare exactly the five required pairs — computed set compare, not eyeballed.
{
  const got = [...arbTargets.map((t) => t.claimed)].sort()
  const want = [...REQUIRED_PAIRS].sort()
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`config: 42161 declares [${got}] — expected [${want}]`)
  }
}

/** The Base ETH/USD anchor — identified by the 8453 block's OWN declared identity, not by address. */
const baseEthUsd = (() => {
  const hit = basePairs.find((p) => EXPECTATIONS.get(p.feed.toLowerCase())?.description === 'ETH / USD')
  if (!hit) throw new Error('parse: no ETH / USD feed found in the 8453 block')
  return { feed: hit.feed, heartbeat: HEARTBEATS.get(hit.feed.toLowerCase()) ?? null }
})()

// ── RPC ──────────────────────────────────────────────────────────────────────────────────────

async function rpc(url, method, params, attempt = 0) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    if (j.error) throw new Error(`RPC ${JSON.stringify(j.error)}`)
    return j.result
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
      return rpc(url, method, params, attempt + 1)
    }
    throw new Error(`${method} @ ${url}: ${e.message}`)
  }
}

async function call(url, to, functionName) {
  const data = encodeFunctionData({ abi: AGGREGATOR_ABI, functionName })
  const raw = await rpc(url, 'eth_call', [{ to, data }, 'latest'])
  return decodeFunctionResult({ abi: AGGREGATOR_ABI, functionName, data: raw })
}

/** Every reading for one feed from one endpoint. */
async function readFeed(url, feed) {
  const code = await rpc(url, 'eth_getCode', [feed, 'latest'])
  const codeBytes = code && code !== '0x' ? (code.length - 2) / 2 : 0
  if (codeBytes === 0) return { codeBytes: 0, dead: true }

  const [description, decimals, round] = await Promise.all([
    call(url, feed, 'description'),
    call(url, feed, 'decimals'),
    call(url, feed, 'latestRoundData'),
  ])
  // aggregator() is not part of AggregatorV3Interface — a proxy that lacks it is not a failure.
  let aggregator = null
  try { aggregator = String(await call(url, feed, 'aggregator')).toLowerCase() } catch { /* absent */ }

  const [roundId, answer, startedAt, updatedAt, answeredInRound] = round
  const dec = Number(decimals)
  return {
    codeBytes, dead: false,
    description: String(description),
    decimals: dec,
    aggregator,
    roundId: roundId.toString(),
    answerRaw: answer.toString(),
    price: Number(answer) / 10 ** dec,
    startedAt: Number(startedAt),
    updatedAt: Number(updatedAt),
    answeredInRound: answeredInRound.toString(),
    ageSec: Math.floor(Date.now() / 1000) - Number(updatedAt),
  }
}

async function assertChain(chain) {
  for (const url of chain.rpcs) {
    const got = await rpc(url, 'eth_chainId', [])
    if (String(got).toLowerCase() !== chain.idHex) {
      throw new Error(`${url} reports chainId ${got}, expected ${chain.idHex} (${chain.name})`)
    }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────

const fail = []
const results = []

console.log(`\nSource: ${FEEDS_TS.replace(REPO + '/', '')}`)
console.log(`Parsed ${arbTargets.length} Arbitrum feeds + Base ETH/USD anchor ${baseEthUsd.feed} (programmatically)\n`)

await assertChain(ARB)
await assertChain(BASE)
console.log(`chainId verified on all ${ARB.rpcs.length + BASE.rpcs.length} endpoints (${ARB.idHex} / ${BASE.idHex})\n`)

for (const t of arbTargets) {
  const reads = []
  for (const url of ARB.rpcs) reads.push({ url, ...(await readFeed(url, t.feed)) })
  const [a, b] = reads

  if (a.dead || b.dead) {
    fail.push(`${t.claimed}: NO CODE at ${t.feed} (the AUDIT-ARBITRUM-46-47 failure mode)`)
    results.push({ ...t, dead: true, reads })
    console.log(`✗ ${t.claimed.padEnd(11)} ${t.feed}  DEAD — eth_getCode empty`)
    continue
  }

  // Identity + cross-RPC agreement, all computed and lower-cased.
  const identityOk = a.description === t.claimed && a.decimals === t.claimedDecimals
  const agree =
    a.description === b.description &&
    a.decimals === b.decimals &&
    (a.aggregator ?? '') === (b.aggregator ?? '') &&
    a.codeBytes === b.codeBytes
  const sameRound = a.roundId === b.roundId
  if (!identityOk) {
    fail.push(`${t.claimed}: IDENTITY MISMATCH — on-chain "${a.description}" (${a.decimals} dp) != claimed "${t.claimed}" (${t.claimedDecimals} dp)`)
  }
  if (!agree) fail.push(`${t.claimed}: RPCs DISAGREE on identity fields`)

  const ceiling = t.heartbeat != null ? Math.round(t.heartbeat * 1.5) : null
  results.push({ ...t, dead: false, identityOk, agree, sameRound, ceiling, reads })

  console.log(
    `${identityOk && agree ? '✓' : '✗'} ${a.description.padEnd(11)} ${t.feed}` +
    `  dp=${a.decimals}  $${a.price.toLocaleString('en-US', { maximumFractionDigits: 6 })}` +
    `  age=${a.ageSec}s/hb=${t.heartbeat ?? '?'}s  agg=${a.aggregator ?? 'n/a'}  agree=${agree ? 'YES' : 'NO'}${sameRound ? '' : ' (round advanced)'}`,
  )
}

// Base ETH/USD anchor.
const baseReads = []
for (const url of BASE.rpcs) baseReads.push({ url, ...(await readFeed(url, baseEthUsd.feed)) })
const baseEth = baseReads[0]
if (baseEth.dead) fail.push(`Base ETH/USD anchor ${baseEthUsd.feed} has NO CODE`)
console.log(
  `\n· BASE anchor ${baseEth.description ?? '?'} ${baseEthUsd.feed}  dp=${baseEth.decimals}` +
  `  $${baseEth.price?.toLocaleString('en-US', { maximumFractionDigits: 2 })}  age=${baseEth.ageSec}s` +
  `  agree=${baseReads[0].description === baseReads[1].description && baseReads[0].decimals === baseReads[1].decimals ? 'YES' : 'NO'}`,
)

// ── Sanity checks ────────────────────────────────────────────────────────────────────────────

const priceOf = (pair) => results.find((r) => r.claimed === pair)?.reads?.[0]?.price
const arbEth = priceOf('ETH / USD')
const wbtc = priceOf('WBTC / USD')

console.log('\n── Sanity checks ──')

// 1. IDENTITY
const idFails = results.filter((r) => r.dead || !r.identityOk)
console.log(`1. IDENTITY   ${idFails.length === 0 ? 'PASS — all 5 description() match the claimed pair'
  : `FAIL — ${idFails.map((r) => r.claimed).join(', ')}`}`)

// 2. MAGNITUDE
const magIssues = []
for (const r of results) {
  if (r.dead || !STABLE_PAIRS.has(r.claimed)) continue
  const p = r.reads[0].price
  if (Math.abs(p - 1) > 0.02) magIssues.push(`${r.claimed} = $${p} (>2% off $1.00)`)
}
if (wbtc != null && arbEth != null && !(wbtc >= 5 * arbEth)) {
  magIssues.push(`WBTC/USD $${wbtc} < 5x ETH/USD $${arbEth}`)
}
const ethDrift = arbEth != null && baseEth.price != null ? Math.abs(arbEth - baseEth.price) / baseEth.price : null
if (ethDrift != null && ethDrift > 0.2) {
  magIssues.push(`Arbitrum ETH/USD $${arbEth} vs Base $${baseEth.price} = ${(ethDrift * 100).toFixed(2)}% (>20%)`)
}
console.log(`2. MAGNITUDE  ${magIssues.length === 0
  ? `PASS — stables within 2% of $1.00; WBTC/ETH ratio ${wbtc && arbEth ? (wbtc / arbEth).toFixed(2) : '?'}x (>=5x); ETH drift vs Base ${ethDrift != null ? (ethDrift * 100).toFixed(3) : '?'}% (<20%)`
  : `FAIL — ${magIssues.join('; ')}`}`)
if (magIssues.length) fail.push(...magIssues.map((m) => `MAGNITUDE: ${m}`))

// 3. FRESHNESS — reported, never judged.
console.log('3. FRESHNESS  (reported, not judged)')
for (const r of results) {
  if (r.dead) continue
  const age = r.reads[0].ageSec
  const within = r.ceiling != null ? age <= r.ceiling : null
  console.log(
    `   ${r.claimed.padEnd(11)} age ${String(age).padStart(6)}s  heartbeat ${String(r.heartbeat ?? '?').padStart(5)}s` +
    `  ceiling(x1.5) ${String(r.ceiling ?? '?').padStart(6)}s  ${within == null ? '—' : within ? 'within' : 'OVER ceiling'}`,
  )
}

console.log('\n── JSON ──')
console.log(JSON.stringify({
  verifiedAt: new Date().toISOString(),
  arbitrumRpcs: ARB.rpcs, baseRpcs: BASE.rpcs,
  feeds: results.map((r) => ({
    claimed: r.claimed, token: r.token, feed: r.feed, dead: r.dead,
    identityOk: r.identityOk ?? false, rpcsAgree: r.agree ?? false, heartbeat: r.heartbeat,
    onChain: r.dead ? null : {
      description: r.reads[0].description, decimals: r.reads[0].decimals,
      price: r.reads[0].price, ageSec: r.reads[0].ageSec,
      aggregator: r.reads[0].aggregator, codeBytes: r.reads[0].codeBytes,
      roundId: r.reads[0].roundId,
    },
    secondRpc: r.dead ? null : {
      description: r.reads[1].description, decimals: r.reads[1].decimals,
      price: r.reads[1].price, aggregator: r.reads[1].aggregator, codeBytes: r.reads[1].codeBytes,
      roundId: r.reads[1].roundId,
    },
  })),
  baseAnchor: { feed: baseEthUsd.feed, description: baseEth.description, price: baseEth.price, ageSec: baseEth.ageSec },
}, null, 2))

if (fail.length) {
  console.error(`\nFAILED (${fail.length}):\n  ${fail.join('\n  ')}`)
  process.exit(1)
}
console.log('\nAll five feeds: code present, identity matches, both RPCs agree.')
