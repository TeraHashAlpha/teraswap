#!/usr/bin/env node
/**
 * TeraSwap — Full Sepolia Deployment Script
 *
 * Deploys BOTH contracts + bootstraps in a single run:
 *   1. Compile (via solc) TeraSwapFeeCollector + TeraSwapOrderExecutor
 *   2. Deploy TeraSwapFeeCollector
 *   3. Deploy TeraSwapOrderExecutor
 *   4. Call bootstrap(routers[], executors[]) on OrderExecutor
 *   5. Verify on-chain state
 *   6. Save deployment manifest
 *
 * USAGE:
 *   # Minimal (uses defaults for Sepolia)
 *   PRIVATE_KEY=0x... node deploy-sepolia.js
 *
 *   # Custom RPC + admin
 *   PRIVATE_KEY=0x... RPC_URL=https://... ADMIN=0x... node deploy-sepolia.js
 *
 *   # Skip compilation (use existing build artifacts — RECOMMENDED)
 *   PRIVATE_KEY=0x... SKIP_COMPILE=1 node deploy-sepolia.js
 *
 * REQUIRED ENV:
 *   PRIVATE_KEY   — Deployer wallet (needs ~0.05 Sepolia ETH)
 *
 * OPTIONAL ENV:
 *   RPC_URL       — Defaults to public Sepolia RPC
 *   ADMIN         — Admin wallet (defaults to deployer)
 *   FEE_RECIPIENT — Fee collection address (defaults to deployer)
 *   EXECUTOR      — Keeper wallet to whitelist (defaults to deployer)
 *   SKIP_COMPILE  — Set to "1" to skip compilation step
 *   DRY_RUN       — Set to "1" to estimate gas only (no deploy)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  getContract,
  encodeDeployData,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import fs from "fs"
import path from "path"
import solc from "solc"

const basePath = decodeURIComponent(path.dirname(new URL(import.meta.url).pathname))
const contractsRoot = path.resolve(basePath, "..")

// ══════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════

const PRIVATE_KEY = process.env.PRIVATE_KEY
const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia.publicnode.com"
const CHAIN_ID = 11155111 // Sepolia only
const WETH_SEPOLIA = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"
const SKIP_COMPILE = process.env.SKIP_COMPILE === "1"
const DRY_RUN = process.env.DRY_RUN === "1"

if (!PRIVATE_KEY) {
  console.error("❌ Missing PRIVATE_KEY")
  console.error("Usage: PRIVATE_KEY=0x... node deploy-sepolia.js")
  process.exit(1)
}

const sepoliaChain = {
  id: CHAIN_ID,
  name: "sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
}

const account = privateKeyToAccount(PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`)

const publicClient = createPublicClient({
  chain: sepoliaChain,
  transport: http(RPC_URL),
})

const walletClient = createWalletClient({
  account,
  chain: sepoliaChain,
  transport: http(RPC_URL),
})

// ══════════════════════════════════════════════════════════════════
//  COMPILE
// ══════════════════════════════════════════════════════════════════

function findImports(importPath) {
  // Try order-engine node_modules first (for @openzeppelin)
  const nmPath = path.join(basePath, "node_modules", importPath)
  if (fs.existsSync(nmPath)) return { contents: fs.readFileSync(nmPath, "utf8") }

  // Try contracts root
  const rootPath = path.join(contractsRoot, importPath)
  if (fs.existsSync(rootPath)) return { contents: fs.readFileSync(rootPath, "utf8") }

  // Try relative to basePath
  const relPath = path.join(basePath, importPath)
  if (fs.existsSync(relPath)) return { contents: fs.readFileSync(relPath, "utf8") }

  return { error: `File not found: ${importPath}` }
}

function compileContracts() {
  console.log("\n⚙️  Compiling contracts with solc (via-IR, optimizer 200)...")

  // Read sources
  const executorSrc = fs.readFileSync(
    path.join(basePath, "TeraSwapOrderExecutor.sol"),
    "utf8"
  )
  const feeCollectorSrc = fs.readFileSync(
    path.join(contractsRoot, "TeraSwapFeeCollector.sol"),
    "utf8"
  )

  const input = {
    language: "Solidity",
    sources: {
      "TeraSwapOrderExecutor.sol": { content: executorSrc },
      "TeraSwapFeeCollector.sol": { content: feeCollectorSrc },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
        },
      },
    },
  }

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
  )

  // Check errors
  if (output.errors) {
    const errors = output.errors.filter((e) => e.severity === "error")
    const warnings = output.errors.filter((e) => e.severity === "warning")

    if (warnings.length > 0) {
      console.log(`   ⚠️  ${warnings.length} warning(s)`)
    }

    if (errors.length > 0) {
      console.error(`\n❌ ${errors.length} compilation error(s):`)
      errors.forEach((e) => console.error(e.formattedMessage))
      process.exit(1)
    }
  }

  // Save build artifacts
  const buildDir = path.join(basePath, "build")
  fs.mkdirSync(buildDir, { recursive: true })

  const artifacts = {}

  for (const [fileName, contracts] of Object.entries(output.contracts)) {
    for (const [contractName, data] of Object.entries(contracts)) {
      if (
        contractName === "TeraSwapOrderExecutor" ||
        contractName === "TeraSwapFeeCollector"
      ) {
        // Save ABI + bytecode
        fs.writeFileSync(
          path.join(buildDir, `${contractName}.abi.json`),
          JSON.stringify(data.abi, null, 2)
        )
        if (data.evm?.bytecode?.object) {
          fs.writeFileSync(
            path.join(buildDir, `${contractName}.bin`),
            data.evm.bytecode.object
          )
        }

        artifacts[contractName] = {
          abi: data.abi,
          bytecode: `0x${data.evm.bytecode.object}`,
        }
        console.log(`   ✅ ${contractName} compiled`)
      }
    }
  }

  return artifacts
}

function loadExistingArtifacts() {
  console.log("\n📂 Loading existing build artifacts...")

  const artifacts = {}
  for (const name of ["TeraSwapFeeCollector", "TeraSwapOrderExecutor"]) {
    const abiPath = path.join(basePath, "build", `${name}.abi.json`)
    const binPath = path.join(basePath, "build", `${name}.bin`)

    if (!fs.existsSync(abiPath) || !fs.existsSync(binPath)) {
      console.error(`❌ Missing artifact for ${name}.`)
      console.error(`   Run: node compile-all.js`)
      console.error(`   Then: SKIP_COMPILE=1 PRIVATE_KEY=0x... node deploy-sepolia.js`)
      process.exit(1)
    }

    artifacts[name] = {
      abi: JSON.parse(fs.readFileSync(abiPath, "utf8")),
      bytecode: `0x${fs.readFileSync(binPath, "utf8").trim()}`,
    }
    console.log(`   ✅ ${name} loaded`)
  }

  return artifacts
}

// ══════════════════════════════════════════════════════════════════
//  DEPLOY
// ══════════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════════════")
  console.log("   TeraSwap — Full Sepolia Deployment")
  console.log("═══════════════════════════════════════════════════════════")

  // ── Step 0: Connect ───────────────────────────────────────────
  const chainId = await publicClient.getChainId()

  if (chainId !== CHAIN_ID) {
    console.error(`❌ Expected Sepolia (${CHAIN_ID}), got chain ${chainId}`)
    console.error("   This script is for Sepolia testnet only.")
    console.error("   For mainnet, use a dedicated mainnet deploy script with extra safeguards.")
    process.exit(1)
  }

  const balance = await publicClient.getBalance({ address: account.address })
  const FEE_RECIPIENT = process.env.FEE_RECIPIENT || account.address
  const ADMIN = process.env.ADMIN || account.address
  const EXECUTOR = process.env.EXECUTOR || account.address

  console.log(`\n   Network:       Sepolia (${CHAIN_ID})`)
  console.log(`   RPC:           ${RPC_URL}`)
  console.log(`   Deployer:      ${account.address}`)
  console.log(`   Balance:       ${formatEther(balance)} ETH`)
  console.log(`   Fee Recipient: ${FEE_RECIPIENT}`)
  console.log(`   Admin:         ${ADMIN}`)
  console.log(`   Executor:      ${EXECUTOR}`)
  console.log(`   WETH:          ${WETH_SEPOLIA}`)

  if (balance === 0n) {
    console.error("\n❌ Deployer has no ETH. Get Sepolia ETH from a faucet:")
    console.error("   https://sepoliafaucet.com")
    console.error("   https://www.alchemy.com/faucets/ethereum-sepolia")
    process.exit(1)
  }

  const minRequired = parseEther("0.01")
  if (balance < minRequired) {
    console.warn(`\n⚠️  Low balance (< 0.01 ETH). Deployment may fail.`)
  }

  // ── Step 1: Compile ───────────────────────────────────────────
  const artifacts = SKIP_COMPILE ? loadExistingArtifacts() : compileContracts()

  // ── Step 2: Gas Estimation ─────────────────────────────────────
  console.log("\n⏳ Estimating gas costs...")

  const fcDeployData = encodeDeployData({
    abi: artifacts.TeraSwapFeeCollector.abi,
    bytecode: artifacts.TeraSwapFeeCollector.bytecode,
    args: [FEE_RECIPIENT, ADMIN],
  })
  const exDeployData = encodeDeployData({
    abi: artifacts.TeraSwapOrderExecutor.abi,
    bytecode: artifacts.TeraSwapOrderExecutor.bytecode,
    args: [FEE_RECIPIENT, ADMIN, WETH_SEPOLIA],
  })

  const fcGas = await publicClient.estimateGas({ data: fcDeployData, account: account.address })
  const exGas = await publicClient.estimateGas({ data: exDeployData, account: account.address })
  const gasPrice = await publicClient.getGasPrice()

  const fcCost = fcGas * gasPrice
  const exCost = exGas * gasPrice
  const bootstrapEstimate = 150_000n // ~150k gas for bootstrap tx
  const bsCost = bootstrapEstimate * gasPrice
  const totalCost = fcCost + exCost + bsCost

  console.log(`   FeeCollector:     ${fcGas.toString()} gas  (~${formatEther(fcCost)} ETH)`)
  console.log(`   OrderExecutor:    ${exGas.toString()} gas  (~${formatEther(exCost)} ETH)`)
  console.log(`   Bootstrap (est):  ${bootstrapEstimate.toString()} gas  (~${formatEther(bsCost)} ETH)`)
  console.log(`   ────────────────────────────────────`)
  console.log(`   Total estimate:   ~${formatEther(totalCost)} ETH`)

  if (balance < totalCost * 2n) {
    console.warn("   ⚠️  Balance is tight — deployment might fail if gas spikes")
  }

  if (DRY_RUN) {
    console.log("\n🏁 DRY RUN complete. No contracts deployed.")
    console.log(`   Required balance: ~${formatEther(totalCost * 2n)} ETH (2x safety margin)`)
    process.exit(0)
  }

  // ── Step 3: Deploy TeraSwapFeeCollector ────────────────────────
  console.log("\n🚀 [1/3] Deploying TeraSwapFeeCollector...")
  const fcHash = await walletClient.deployContract({
    abi: artifacts.TeraSwapFeeCollector.abi,
    bytecode: artifacts.TeraSwapFeeCollector.bytecode,
    args: [FEE_RECIPIENT, ADMIN],
  })
  console.log(`   Tx: ${fcHash}`)
  console.log("   ⏳ Waiting for confirmation...")
  const fcReceipt = await publicClient.waitForTransactionReceipt({ hash: fcHash })
  const fcAddress = fcReceipt.contractAddress
  console.log(`   ✅ FeeCollector deployed: ${fcAddress}`)

  // ── Step 4: Deploy TeraSwapOrderExecutor ───────────────────────
  console.log("\n🚀 [2/3] Deploying TeraSwapOrderExecutor...")
  const exHash = await walletClient.deployContract({
    abi: artifacts.TeraSwapOrderExecutor.abi,
    bytecode: artifacts.TeraSwapOrderExecutor.bytecode,
    args: [FEE_RECIPIENT, ADMIN, WETH_SEPOLIA],
  })
  console.log(`   Tx: ${exHash}`)
  console.log("   ⏳ Waiting for confirmation...")
  const exReceipt = await publicClient.waitForTransactionReceipt({ hash: exHash })
  const exAddress = exReceipt.contractAddress
  console.log(`   ✅ OrderExecutor deployed: ${exAddress}`)

  // ── Step 5: Bootstrap OrderExecutor ────────────────────────────
  console.log("\n🚀 [3/3] Bootstrapping OrderExecutor...")
  console.log("   Setting up routers + executors in a single tx...")

  const routers = [fcAddress]
  const executors = [EXECUTOR]

  console.log(`   Routers:   [${routers.join(", ")}]`)
  console.log(`   Executors: [${executors.join(", ")}]`)

  const executorContract = getContract({
    address: exAddress,
    abi: artifacts.TeraSwapOrderExecutor.abi,
    client: { public: publicClient, wallet: walletClient },
  })

  const bootstrapHash = await executorContract.write.bootstrap([routers, executors])
  console.log(`   Tx: ${bootstrapHash}`)
  await publicClient.waitForTransactionReceipt({ hash: bootstrapHash })
  console.log("   ✅ Bootstrap complete")

  // ── Step 6: Verify On-Chain State ──────────────────────────────
  console.log("\n🔍 Verifying on-chain state...")
  let allOk = true

  // FeeCollector checks
  const feeCollectorContract = getContract({
    address: fcAddress,
    abi: artifacts.TeraSwapFeeCollector.abi,
    client: publicClient,
  })

  const fcFeeRecipient = await feeCollectorContract.read.feeRecipient()
  const fcAdmin = await feeCollectorContract.read.admin()
  const fcPaused = await feeCollectorContract.read.paused()

  console.log(`\n   TeraSwapFeeCollector (${fcAddress}):`)
  check("feeRecipient", fcFeeRecipient, FEE_RECIPIENT)
  check("admin", fcAdmin, ADMIN)
  check("paused", fcPaused, false)

  // OrderExecutor checks
  const exFeeRecipient = await executorContract.read.feeRecipient()
  const exAdmin = await executorContract.read.admin()
  const exWeth = await executorContract.read.WETH()
  const exPaused = await executorContract.read.paused()
  const exBootstrapped = await executorContract.read.bootstrapped()
  const routerWhitelisted = await executorContract.read.whitelistedRouters([fcAddress])
  const executorWhitelisted = await executorContract.read.whitelistedExecutors([EXECUTOR])

  console.log(`\n   TeraSwapOrderExecutor (${exAddress}):`)
  check("feeRecipient", exFeeRecipient, FEE_RECIPIENT)
  check("admin", exAdmin, ADMIN)
  check("WETH", exWeth, WETH_SEPOLIA)
  check("paused", exPaused, false)
  check("bootstrapped", exBootstrapped, true)
  check(`router[${fcAddress}]`, routerWhitelisted, true)
  check(`executor[${EXECUTOR}]`, executorWhitelisted, true)

  function check(label, actual, expected) {
    const actualStr = String(actual).toLowerCase()
    const expectedStr = String(expected).toLowerCase()
    if (actualStr === expectedStr) {
      console.log(`   ✅ ${label} = ${actual}`)
    } else {
      console.log(`   ❌ ${label} = ${actual} (expected: ${expected})`)
      allOk = false
    }
  }

  if (!allOk) {
    console.error("\n⚠️  Some on-chain values don't match expectations!")
  } else {
    console.log("\n   ✅ All on-chain state verified!")
  }

  // ── Step 7: Save Deployment Manifest ──────────────────────────
  const manifest = {
    network: "sepolia",
    chainId: CHAIN_ID,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    admin: ADMIN,
    feeRecipient: FEE_RECIPIENT,
    executor: EXECUTOR,
    weth: WETH_SEPOLIA,
    contracts: {
      TeraSwapFeeCollector: {
        address: fcAddress,
        txHash: fcHash,
        constructorArgs: [FEE_RECIPIENT, ADMIN],
      },
      TeraSwapOrderExecutor: {
        address: exAddress,
        txHash: exHash,
        constructorArgs: [FEE_RECIPIENT, ADMIN, WETH_SEPOLIA],
      },
    },
    bootstrap: {
      routers,
      executors,
      txHash: bootstrapHash,
    },
    etherscan: {
      feeCollector: `https://sepolia.etherscan.io/address/${fcAddress}`,
      orderExecutor: `https://sepolia.etherscan.io/address/${exAddress}`,
    },
  }

  // Save to order-engine directory
  const manifestPath = path.join(basePath, `deployment-${CHAIN_ID}.json`)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`\n📄 Manifest saved: ${manifestPath}`)

  // Also save FeeCollector deployment separately
  const fcManifestPath = path.join(contractsRoot, `deployment-feecollector-${CHAIN_ID}.json`)
  fs.writeFileSync(
    fcManifestPath,
    JSON.stringify(
      {
        address: fcAddress,
        chainId: CHAIN_ID,
        deployer: account.address,
        feeRecipient: FEE_RECIPIENT,
        admin: ADMIN,
        txHash: fcHash,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  )

  // ── Summary ───────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════")
  console.log("   ✅ DEPLOYMENT COMPLETE")
  console.log("═══════════════════════════════════════════════════════════")
  console.log()
  console.log(`   FeeCollector:    ${fcAddress}`)
  console.log(`   OrderExecutor:   ${exAddress}`)
  console.log()
  console.log("   Etherscan:")
  console.log(`     ${manifest.etherscan.feeCollector}`)
  console.log(`     ${manifest.etherscan.orderExecutor}`)
  console.log()
  console.log("┌──────────────────────────────────────────────────────────┐")
  console.log("│  NEXT STEPS:                                             │")
  console.log("│                                                          │")
  console.log("│  1. Update .env.local:                                   │")
  console.log(`│     NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS=${exAddress}`)
  console.log(`│     NEXT_PUBLIC_FEE_COLLECTOR=${fcAddress}`)
  console.log("│                                                          │")
  console.log("│  2. Update executor/.env.executor:                       │")
  console.log(`│     ORDER_EXECUTOR_ADDRESS=${exAddress}`)
  console.log("│                                                          │")
  console.log("│  3. Run Supabase migration (if first deploy):            │")
  console.log("│     Copy schema.sql into Supabase SQL Editor             │")
  console.log("│                                                          │")
  console.log("│  4. Start the executor keeper:                           │")
  console.log("│     cd executor && node executor.js                      │")
  console.log("│                                                          │")
  console.log("│  5. Verify on Etherscan (optional):                      │")
  console.log("│     npx hardhat verify --network sepolia \\")
  console.log(`│       ${exAddress} ${FEE_RECIPIENT} ${ADMIN} ${WETH_SEPOLIA}`)
  console.log("│                                                          │")
  console.log("│  6. Test a swap on the frontend!                         │")
  console.log("└──────────────────────────────────────────────────────────┘")
}

main().catch((err) => {
  console.error("\n❌ Deployment failed:", err.message || err)
  if (err.data) console.error("   Revert data:", err.data)
  process.exit(1)
})
