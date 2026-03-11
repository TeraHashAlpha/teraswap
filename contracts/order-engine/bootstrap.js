/**
 * TeraSwap — Router Bootstrap Script
 *
 * One-time script to whitelist DEX routers on the deployed contract.
 * Must be called by the admin wallet before any order can execute.
 *
 * Usage:
 *   PRIVATE_KEY=0x... RPC_URL=https://... CONTRACT=0x... node bootstrap.js
 *
 * For Sepolia testnet:
 *   PRIVATE_KEY=0x... RPC_URL=https://ethereum-sepolia.publicnode.com CONTRACT=0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130 node bootstrap.js
 */

import { ethers } from 'ethers'

// ── Router addresses per chain ──────────────────────────────

const ROUTERS = {
  // Ethereum Mainnet
  1: [
    { address: '0x111111125421cA6dc452d289314280a0f8842A65', label: '1inch v6' },
    { address: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF', label: '0x Exchange Proxy' },
    { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', label: 'Uniswap V3 SwapRouter' },
    { address: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', label: 'Paraswap Augustus v6' },
  ],
  // Sepolia Testnet
  11155111: [
    { address: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E', label: 'Uniswap V3 SwapRouter (Sepolia)' },
    // Add more Sepolia routers as needed
  ],
  // Base
  8453: [
    { address: '0x111111125421cA6dc452d289314280a0f8842A65', label: '1inch v6' },
    { address: '0x2626664c2603336E57B271c5C0b26F421741e481', label: 'Uniswap V3 SwapRouter02 (Base)' },
  ],
  // Arbitrum
  42161: [
    { address: '0x111111125421cA6dc452d289314280a0f8842A65', label: '1inch v6' },
    { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', label: 'Uniswap V3 SwapRouter (Arbitrum)' },
  ],
}

const BOOTSTRAP_ABI = [
  'function bootstrap(address[] calldata routers) external',
  'function bootstrapped() view returns (bool)',
  'function admin() view returns (address)',
  'function whitelistedRouters(address) view returns (bool)',
]

async function main() {
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const RPC_URL = process.env.RPC_URL
  const CONTRACT = process.env.CONTRACT

  if (!PRIVATE_KEY || !RPC_URL || !CONTRACT) {
    console.error('Usage: PRIVATE_KEY=0x... RPC_URL=https://... CONTRACT=0x... node bootstrap.js')
    process.exit(1)
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider)
  const contract = new ethers.Contract(CONTRACT, BOOTSTRAP_ABI, wallet)

  const network = await provider.getNetwork()
  const chainId = Number(network.chainId)

  console.log(`\n🔗 Chain: ${network.name} (${chainId})`)
  console.log(`👤 Admin: ${wallet.address}`)
  console.log(`📜 Contract: ${CONTRACT}\n`)

  // Check if already bootstrapped
  const alreadyBootstrapped = await contract.bootstrapped()
  if (alreadyBootstrapped) {
    console.log('✅ Contract already bootstrapped. Checking router status...\n')

    const routerList = ROUTERS[chainId] || []
    for (const router of routerList) {
      const isWhitelisted = await contract.whitelistedRouters(router.address)
      console.log(`  ${isWhitelisted ? '✅' : '❌'} ${router.label}: ${router.address}`)
    }
    return
  }

  // Check admin
  const admin = await contract.admin()
  if (admin.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`❌ Wallet ${wallet.address} is not the admin (${admin})`)
    process.exit(1)
  }

  // Get routers for this chain
  const routerList = ROUTERS[chainId]
  if (!routerList || routerList.length === 0) {
    console.error(`❌ No routers configured for chain ${chainId}`)
    console.error('   Add routers to the ROUTERS object in this script')
    process.exit(1)
  }

  console.log(`📋 Bootstrapping ${routerList.length} router(s):\n`)
  for (const router of routerList) {
    console.log(`  → ${router.label}: ${router.address}`)
  }
  console.log('')

  // Execute bootstrap
  const addresses = routerList.map(r => r.address)
  const tx = await contract.bootstrap(addresses)
  console.log(`📤 TX sent: ${tx.hash}`)

  const receipt = await tx.wait(1)
  console.log(`✅ Bootstrap complete! Gas used: ${receipt.gasUsed.toString()}`)
  console.log(`\n🎉 ${routerList.length} router(s) whitelisted. Orders can now be executed.\n`)
}

main().catch(err => {
  console.error('💥 Bootstrap failed:', err.message)
  process.exit(1)
})
