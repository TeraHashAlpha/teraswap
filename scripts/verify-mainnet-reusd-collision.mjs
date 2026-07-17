#!/usr/bin/env node
/**
 * [CHORE-CATALOG-REUSD-COLLISION] Verify the Re Protocol reUSD address on Ethereum mainnet
 * before it lands in the token catalog. THE METHOD IS THE DELIVERABLE (cf.
 * scripts/verify-arbitrum-addresses.mjs): this script performs the on-chain reads and prints
 * the exact address string — the catalog source copies it from THIS OUTPUT, never retyped
 * by hand (per feedback_address_hygiene).
 *
 * Context: mainnet already has an unrelated token using the same ticker — Resupply USD
 * `reUSD` (0x57aB1E0003F623289CD798B1824Be09a793e4Bec, VERIFIED CORRECT, untouched by this
 * chore). Re Protocol's reUSD (re.xyz; CoinGecko `re-protocol-reusd`) is a SEPARATE token
 * being added as a disambiguated second catalog entry, never a replacement.
 *
 * For the target address, from TWO independent mainnet RPCs (asserting chainId === 0x1 on
 * both — never trust a single endpoint):
 *   - eth_getCode non-empty (deployed contract).
 *   - symbol() / name() / decimals() read on-chain — expect symbol "reUSD", a name
 *     identifying Re Protocol (Etherscan: "Re Protocol Deposit Token"), decimals AS READ
 *     (not assumed).
 *
 * Run:
 *   node scripts/verify-mainnet-reusd-collision.mjs
 * Writes docs/Reports/MAINNET-REUSD-COLLISION-MANIFEST.json. Exits 1 on any verification
 * failure — no manifest is written on failure, so an unverified address can never silently
 * get pinned as "verified". Read-only (public RPCs), no keys, no on-chain writes.
 */
import { writeFileSync } from 'node:fs'
import { encodeFunctionData, decodeFunctionResult } from 'viem'

const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org']
const EXPECTED_CHAIN_ID_HEX = '0x1' // mainnet

const TARGET = {
  key: 'reUSD (Re Protocol)',
  address: '0x5086bf358635B81D8C47C66d1C8b9E567Db70c72',
  expectSymbol: 'reUSD',
  expectNameSubstr: 'Re Protocol',
}

const ERC20_ABI = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
]

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

const manifest = { generatedAt: new Date().toISOString(), rpcs: RPCS, entries: [] }
let failures = 0

function report(key, address, ok, detail, extra = {}) {
  console.log(`${ok ? '✓' : '✗'} [token] ${key} ${address} — ${detail}`)
  if (!ok) failures++
  manifest.entries.push({ category: 'token', key, address, ok, detail, ...extra })
}

async function main() {
  const blocks = {}
  for (const rpc of RPCS) {
    const cid = await getChainId(rpc)
    if (cid !== EXPECTED_CHAIN_ID_HEX) {
      console.error(`FATAL: ${rpc} reports chainId ${cid}, expected ${EXPECTED_CHAIN_ID_HEX} (1)`)
      process.exit(1)
    }
    blocks[rpc] = await getBlockNumber(rpc)
  }
  manifest.blocks = blocks
  console.log(`chainId 0x1 confirmed on both RPCs. Blocks: ${JSON.stringify(blocks)}\n`)

  let ok = true
  const perRpc = []
  for (const rpc of RPCS) {
    const code = await getCode(rpc, TARGET.address)
    const codeOk = code && code !== '0x'
    let symbol = null, name = null, decimals = null
    if (codeOk) {
      try { symbol = await readContract(rpc, TARGET.address, ERC20_ABI, 'symbol') } catch { /* non-fatal below */ }
      try { name = await readContract(rpc, TARGET.address, ERC20_ABI, 'name') } catch { /* non-fatal below */ }
      try { decimals = await readContract(rpc, TARGET.address, ERC20_ABI, 'decimals') } catch { decimals = null }
    }
    const symOk = symbol === TARGET.expectSymbol
    const nameOk = typeof name === 'string' && name.includes(TARGET.expectNameSubstr)
    perRpc.push({ rpc, codeLen: code?.length ?? 0, symbol, name, decimals })
    ok = ok && codeOk && symOk && nameOk && decimals !== null
  }
  report(
    TARGET.key,
    TARGET.address,
    ok,
    `symbol="${TARGET.expectSymbol}", name contains "${TARGET.expectNameSubstr}", decimals read (not assumed) on both RPCs`,
    { perRpc },
  )

  console.log(`\n${manifest.entries.length} entries checked, ${failures} failure(s).`)
  if (failures === 0) {
    writeFileSync('docs/Reports/MAINNET-REUSD-COLLISION-MANIFEST.json', JSON.stringify(manifest, null, 2) + '\n')
    console.log('Wrote docs/Reports/MAINNET-REUSD-COLLISION-MANIFEST.json')
  } else {
    console.error('NOT writing the manifest — fix the failing entry first.')
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
