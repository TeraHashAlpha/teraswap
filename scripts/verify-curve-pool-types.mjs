// Derives and proves each CURVE_POOLS entry's Router NG `pool_type` selector
// (uint256[5][5] _swap_params row index [3]) by brute-forcing candidate values
// against a real eth_call, both directions, for every pool in curve.ts.
//
// Run with: npx tsx scripts/verify-curve-pool-types.mjs
//
// Never hardcodes a pool/token/router address — every address below is read
// live from src/lib/adapters/curve.ts.
import {
  createPublicClient,
  http,
  encodeFunctionData,
  decodeFunctionResult,
} from 'viem'
import {
  CURVE_POOLS,
  CURVE_ROUTER_NG,
  CURVE_ROUTER_ABI,
} from '../src/lib/adapters/curve.ts'

const RPC_URL = process.env.CURVE_VERIFY_RPC_URL || 'https://eth.llamarpc.com'

// Router NG pool_type selectors per Curve docs — never guessed, only used as
// brute-force candidates; the on-chain call is what proves (or disproves) each.
const CANDIDATE_POOL_TYPES = [0, 1, 2, 3, 4, 10, 20, 30]

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

const client = createPublicClient({ transport: http(RPC_URL) })

const ERC20_DECIMALS_ABI = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
]

async function decimalsOf(token) {
  try {
    const data = await client.readContract({
      address: token,
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
    })
    return Number(data)
  } catch {
    // Native-ETH placeholder (used by some pools, e.g. steth) has no decimals()
    // function — it is always 18.
    return 18
  }
}

function buildSwapParams(i, j, swapType, poolType) {
  const zeroRow = [0n, 0n, 0n, 0n, 0n]
  return [
    [BigInt(i), BigInt(j), BigInt(swapType), BigInt(poolType), 0n],
    zeroRow, zeroRow, zeroRow, zeroRow,
  ]
}

async function tryGetDy(pool, tokenIn, tokenOut, i, j, swapType, poolType, amount) {
  const route = [tokenIn, pool, tokenOut, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR]
  const swapParams = buildSwapParams(i, j, swapType, poolType)
  const pools = [pool, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR]

  const data = encodeFunctionData({
    abi: CURVE_ROUTER_ABI,
    functionName: 'get_dy',
    args: [route, swapParams, amount, pools],
  })

  try {
    const result = await client.call({ to: CURVE_ROUTER_NG, data })
    if (!result.data || result.data === '0x') return { ok: false, reason: 'empty result' }
    const decoded = decodeFunctionResult({
      abi: CURVE_ROUTER_ABI,
      functionName: 'get_dy',
      data: result.data,
    })
    if (decoded === 0n) return { ok: false, reason: 'zero output' }
    return { ok: true, amountOut: decoded }
  } catch (err) {
    return { ok: false, reason: err?.shortMessage || err?.message || String(err) }
  }
}

async function main() {
  console.log(`RPC: ${RPC_URL}`)
  console.log(`Router: ${CURVE_ROUTER_NG} (len ${CURVE_ROUTER_NG.length})`)
  console.log('')

  const proven = {}

  for (const [name, info] of Object.entries(CURVE_POOLS)) {
    console.log(`── ${name} ──`)
    console.log(`  pool ${info.pool} (len ${info.pool.length})`)
    for (const c of info.coins) console.log(`  coin ${c} (len ${c.length})`)

    const [tokenA, tokenB] = info.coins
    const [decA, decB] = await Promise.all([decimalsOf(tokenA), decimalsOf(tokenB)])
    const amountAB = 10n ** BigInt(decA)
    const amountBA = 10n ** BigInt(decB)

    let chosen = null
    for (const poolType of CANDIDATE_POOL_TYPES) {
      const fwd = await tryGetDy(info.pool, tokenA, tokenB, 0, 1, info.swapType, poolType, amountAB)
      const rev = await tryGetDy(info.pool, tokenB, tokenA, 1, 0, info.swapType, poolType, amountBA)
      const fwdMsg = fwd.ok ? `SUCCESS amountOut=${fwd.amountOut}` : `REVERT (${fwd.reason})`
      const revMsg = rev.ok ? `SUCCESS amountOut=${rev.amountOut}` : `REVERT (${rev.reason})`
      console.log(`  poolType=${poolType}: ${tokenA.slice(0, 10)}->${tokenB.slice(0, 10)} ${fwdMsg} | reverse ${revMsg}`)
      if (fwd.ok && rev.ok && chosen === null) chosen = poolType
    }

    // Explicit control: prove the current 0n default reverts on this pool too.
    const zeroCtl = await tryGetDy(info.pool, tokenA, tokenB, 0, 1, info.swapType, 0, amountAB)
    console.log(`  [control] poolType=0 (today's hardcoded default): ${zeroCtl.ok ? `SUCCESS amountOut=${zeroCtl.amountOut}` : `REVERT (${zeroCtl.reason})`}`)

    if (chosen === null) {
      console.log(`  RESULT: UNRESOLVED — no candidate poolType succeeded both directions. Left out of routing.`)
    } else {
      console.log(`  RESULT: poolType=${chosen} PROVEN on-chain both directions.`)
      proven[name] = chosen
    }
    console.log('')
  }

  console.log('=== Summary ===')
  for (const name of Object.keys(CURVE_POOLS)) {
    console.log(`${name}: ${name in proven ? `poolType=${proven[name]}` : 'UNRESOLVED (excluded)'}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
