/**
 * [fix/script-stdout-truncated-on-exit] Test preload for plan.ts (`node --import <this> ...`): replaces globalThis.fetch with an
 * in-process JSON-RPC node, so plan.ts runs offline against the REAL config and docs/DEPLOYMENTS.md.
 *
 * What it answers: eth_chainId (by the RPC URL), eth_getCode (empty only for the sentinel's dead address), and the eth_calls plan.ts
 * makes: admin, TIMELOCK_*, tokenUsdFeeds (registered exactly as the config says for the enabled phase-0 rows, unregistered for the
 * rest), ERC-20 and feed decimals, latestRoundData (fresh, 1.00), and description(). description() returns the config text followed by
 * PAD_CHARS filler for the rows that are not phase-0: that row is then BLOCKED, and plan.ts prints the long text in its JSON (twice),
 * which is what makes the report bigger than a pipe. Nothing here is a claim about a chain.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const viem = createRequire(resolve(ROOT, 'package.json'))('viem')
const { parseAbi, decodeFunctionData, encodeFunctionResult, keccak256, toBytes, getAddress } = viem
const config = JSON.parse(readFileSync(resolve(ROOT, 'src/config/dca-feed-registrations.json'), 'utf8'))
const PAD_CHARS = Number(process.argv.find((a) => a.startsWith('--pad='))?.slice(6) ?? 8000)

const ABI = parseAbi([
  'function admin() view returns (address)',
  'function TIMELOCK_ORACLE_CHANGE() view returns (uint256)',
  'function TIMELOCK_GRACE() view returns (uint256)',
  'function tokenUsdFeeds(address) view returns (address feed,uint8 feedDecimals,uint8 tokenDecimals,uint256 maxStaleness,bool registered)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
])

const deployments = readFileSync(resolve(ROOT, 'docs/DEPLOYMENTS.md'), 'utf8').split('\n')
const hex = /`(0x[0-9a-fA-F]{40})`/
const admin = deployments.find((l) => l.startsWith('|') && l.includes('Contract admin')).match(hex)[1]
const dead = getAddress('0x' + keccak256(toBytes('dca-feeds negative control')).slice(26)).toLowerCase()

const rowsByToken = new Map()
const rowsByFeed = new Map()
for (const chain of Object.values(config.chains)) {
  for (const r of chain.rows) { rowsByToken.set(r.token.toLowerCase(), r); rowsByFeed.set(r.feed.toLowerCase(), r) }
}
const ZERO = '0x' + '00'.repeat(20)

function ethCall(to, data) {
  const { functionName, args } = decodeFunctionData({ abi: ABI, data })
  const enc = (result) => encodeFunctionResult({ abi: ABI, functionName, result })
  const now = BigInt(Math.floor(Date.now() / 1000))
  switch (functionName) {
    case 'admin': return enc(admin)
    case 'TIMELOCK_ORACLE_CHANGE': return enc(172800n)
    case 'TIMELOCK_GRACE': return enc(604800n)
    case 'tokenUsdFeeds': {
      const r = rowsByToken.get(String(args[0]).toLowerCase())
      return r && r.phase === 0 && r.enabled
        ? enc([r.feed, r.decimals, r.tokenDecimals, BigInt(r.maxStaleness ?? 0), true])
        : enc([ZERO, 0, 0, 0n, false])
    }
    case 'decimals': {
      const feed = rowsByFeed.get(to.toLowerCase())
      if (feed) return enc(feed.decimals)
      return enc(rowsByToken.get(to.toLowerCase())?.tokenDecimals ?? 18)
    }
    case 'description': {
      const r = rowsByFeed.get(to.toLowerCase())
      return enc(r && r.phase === 0 ? r.description : `${r?.description ?? 'X / USD'} ${'x'.repeat(PAD_CHARS)}`)
    }
    case 'latestRoundData': return enc([1n, 100000000n, now, now, 1n])
    default: throw new Error(`plan-rpc-stub: no answer for ${functionName}`)
  }
}

function answer(url, call) {
  const id = call.id
  try {
    const [p0] = call.params ?? []
    switch (call.method) {
      case 'eth_chainId': return { jsonrpc: '2.0', id, result: String(url).includes('base') ? '0x2105' : '0xa4b1' }
      case 'eth_getCode': return { jsonrpc: '2.0', id, result: String(p0).toLowerCase() === dead ? '0x' : '0x60' }
      case 'eth_call': return { jsonrpc: '2.0', id, result: ethCall(p0.to, p0.data) }
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `plan-rpc-stub: no ${call.method}` } }
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } }
  }
}

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  const payload = Array.isArray(body) ? body.map((c) => answer(url, c)) : answer(url, body)
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}
