/**
 * TeraSwapOrderExecutor v2 — Deploy Script
 *
 * Deploys the compiled contract to the target network.
 *
 * USAGE:
 *   # Sepolia testnet
 *   PRIVATE_KEY=0x... RPC_URL=https://ethereum-sepolia.publicnode.com node deploy.js
 *
 *   # Ethereum mainnet
 *   PRIVATE_KEY=0x... RPC_URL=https://eth.llamarpc.com CHAIN_ID=1 node deploy.js
 *
 * REQUIRED ENV:
 *   PRIVATE_KEY  — deployer wallet private key (must have ETH for gas)
 *   RPC_URL      — JSON-RPC endpoint
 *
 * OPTIONAL ENV:
 *   CHAIN_ID     — defaults to 11155111 (Sepolia)
 *   FEE_RECIPIENT — fee collection address (defaults to deployer)
 *   ADMIN         — contract admin/owner (defaults to deployer)
 *   WETH          — WETH address (auto-detected per chain)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  getContract,
  encodeDeployData,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import fs from 'fs'
import path from 'path'

const basePath = decodeURIComponent(path.dirname(new URL(import.meta.url).pathname))

// ── Config ──────────────────────────────────────────────────
const PRIVATE_KEY = process.env.PRIVATE_KEY
const RPC_URL = process.env.RPC_URL
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '11155111') // Default: Sepolia

// WETH addresses per chain
const WETH_ADDRESSES = {
  1:        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Ethereum mainnet
  11155111: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9', // Sepolia
  8453:     '0x4200000000000000000000000000000000000006', // Base
  42161:    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Arbitrum
}

if (!PRIVATE_KEY || !RPC_URL) {
  console.error('❌ Missing PRIVATE_KEY or RPC_URL')
  console.error('Usage: PRIVATE_KEY=0x... RPC_URL=https://... node deploy.js')
  process.exit(1)
}

// ── Load compiled artifacts ─────────────────────────────────
const abiPath = path.join(basePath, 'build', 'TeraSwapOrderExecutor.abi.json')
const binPath = path.join(basePath, 'build', 'TeraSwapOrderExecutor.bin')

if (!fs.existsSync(abiPath) || !fs.existsSync(binPath)) {
  console.error('❌ Compiled artifacts not found. Run: node compile.js')
  process.exit(1)
}

const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'))
const bytecode = `0x${fs.readFileSync(binPath, 'utf8').trim()}`

// ── Deploy ──────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════')
  console.log('  TeraSwapOrderExecutor v2 — Deployment')
  console.log('═══════════════════════════════════════════════════')
  console.log()

  const account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`)

  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  })

  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
  })

  const chainId = await publicClient.getChainId()
  const balance = await publicClient.getBalance({ address: account.address })
  const FEE_RECIPIENT = process.env.FEE_RECIPIENT || account.address
  const ADMIN = process.env.ADMIN || account.address
  const WETH = process.env.WETH || WETH_ADDRESSES[chainId]

  if (!WETH) {
    console.error(`❌ No WETH address for chain ${chainId}. Set WETH env var.`)
    process.exit(1)
  }

  console.log(`  Network:       chain ${chainId}`)
  console.log(`  Deployer:      ${account.address}`)
  console.log(`  Balance:       ${formatEther(balance)} ETH`)
  console.log(`  Fee recipient: ${FEE_RECIPIENT}`)
  console.log(`  Admin:         ${ADMIN}`)
  console.log(`  WETH:          ${WETH}`)
  console.log()

  if (balance === 0n) {
    console.error('❌ Deployer has no ETH for gas')
    process.exit(1)
  }

  // Estimate gas
  console.log('⏳ Estimating gas...')

  const deployData = encodeDeployData({ abi, bytecode, args: [FEE_RECIPIENT, ADMIN, WETH] })
  const gasEstimate = await publicClient.estimateGas({ data: deployData, account: account.address })
  const gasPrice = await publicClient.getGasPrice()

  const estimatedCost = gasEstimate * gasPrice
  console.log(`  Gas estimate:  ${gasEstimate.toString()}`)
  console.log(`  Est. cost:     ${formatEther(estimatedCost)} ETH`)
  console.log()

  if (balance < estimatedCost * 2n) {
    console.warn('⚠️  Low balance — deployment might fail if gas spikes')
  }

  // Deploy
  console.log('🚀 Deploying...')
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [FEE_RECIPIENT, ADMIN, WETH],
  })
  console.log(`  Tx hash:       ${hash}`)

  console.log('⏳ Waiting for confirmation...')
  const receipt = await publicClient.waitForTransactionReceipt({ hash })

  const address = receipt.contractAddress
  console.log()
  console.log('═══════════════════════════════════════════════════')
  console.log(`  ✅ Deployed at: ${address}`)
  console.log('═══════════════════════════════════════════════════')
  console.log()

  // ── Whitelist default routers ──────────────────────────────
  const routers = {
    '1inch':      '0x111111125421cA6dc452d289314280a0f8842A65',
    'paraswap':   '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57',
    'uniswap-v3': '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  }

  const contract = getContract({
    address,
    abi,
    client: { public: publicClient, wallet: walletClient },
  })

  // Only whitelist on mainnet (some routers might not exist on testnet)
  if (chainId === 1) {
    console.log('⏳ Whitelisting routers...')
    for (const [name, addr] of Object.entries(routers)) {
      try {
        const txHash = await contract.write.setRouterWhitelist([addr, true])
        await publicClient.waitForTransactionReceipt({ hash: txHash })
        console.log(`  ✅ ${name}: ${addr}`)
      } catch (err) {
        console.warn(`  ⚠️  ${name}: ${err.message}`)
      }
    }
  } else {
    console.log('ℹ️  Skipping router whitelist on testnet (routers may not exist)')
    console.log('    Run manually: contract.setRouterWhitelist(routerAddr, true)')
  }

  // ── Save deployment info ──────────────────────────────────
  const deployInfo = {
    address,
    chainId,
    deployer: account.address,
    feeRecipient: FEE_RECIPIENT,
    admin: ADMIN,
    weth: WETH,
    txHash: hash,
    timestamp: new Date().toISOString(),
  }

  const deployPath = path.join(basePath, `deployment-${chainId}.json`)
  fs.writeFileSync(deployPath, JSON.stringify(deployInfo, null, 2))
  console.log()
  console.log(`📄 Deployment info saved to: ${deployPath}`)

  // ── Next steps ────────────────────────────────────────────
  console.log()
  console.log('┌──────────────────────────────────────────────────┐')
  console.log('│  NEXT STEPS:                                     │')
  console.log('│                                                   │')
  console.log('│  1. Add to .env.local:                            │')
  console.log(`│     NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS=${address}`)
  console.log('│                                                   │')
  console.log('│  2. Run Supabase migration:                       │')
  console.log('│     Copy schema.sql into Supabase SQL Editor      │')
  console.log('│                                                   │')
  console.log('│  3. Deploy Gelato Web3 Function:                  │')
  console.log('│     cd gelato && npx w3f deploy web3Function.ts   │')
  console.log('│                                                   │')
  console.log('│  4. Verify contract on Etherscan:                 │')
  console.log(`│     npx hardhat verify ${address} \\`)
  console.log(`│       ${FEE_RECIPIENT} ${ADMIN} ${WETH}`)
  console.log('└──────────────────────────────────────────────────┘')
}

main().catch((err) => {
  console.error('❌ Deployment failed:', err.message || err)
  process.exit(1)
})
