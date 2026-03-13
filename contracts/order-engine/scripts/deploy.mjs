/**
 * Deploy TeraSwapOrderExecutor v2 — Standalone (no Hardhat needed)
 *
 * Uses the pre-compiled bytecode from build/ directory.
 *
 * Usage:
 *   cd contracts/order-engine
 *   node scripts/deploy.mjs
 *
 * Required env vars (create a .env file or export):
 *   DEPLOYER_PRIVATE_KEY  — Private key of the deployer wallet (with ETH for gas)
 *   RPC_URL               — Ethereum mainnet RPC (Alchemy/Infura)
 *
 * Optional env vars:
 *   FEE_RECIPIENT         — Address that receives the 0.1% swap fee (default: deployer)
 *   ADMIN_ADDRESS         — Admin address (default: deployer)
 *   EXECUTOR_ADDRESS      — Executor wallet address (default: deployer)
 */

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── Load .env ────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Config ───────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;

if (!RPC_URL || !DEPLOYER_KEY) {
  console.error("❌ Missing required env vars: RPC_URL, DEPLOYER_PRIVATE_KEY");
  console.error("   Create a .env file in contracts/order-engine/ with these values.");
  process.exit(1);
}

// ── Load compiled artifacts ──────────────────────────────────
const buildDir = path.join(__dirname, "..", "build");
const abi = JSON.parse(fs.readFileSync(path.join(buildDir, "TeraSwapOrderExecutor.abi.json"), "utf8"));
const bytecode = "0x" + fs.readFileSync(path.join(buildDir, "TeraSwapOrderExecutor.bin"), "utf8").trim();

// ── Connect ──────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);

// ── Constructor args ─────────────────────────────────────────
const WETH = ethers.getAddress("0xc02aaa39b223fe8d0a6e5c4f27ead9083c756cc2"); // Mainnet WETH
const FEE_RECIPIENT = process.env.FEE_RECIPIENT || wallet.address;
const ADMIN = process.env.ADMIN_ADDRESS || wallet.address;
const EXECUTOR = process.env.EXECUTOR_ADDRESS || wallet.address;

// Mainnet routers (same as config.ts)
const ROUTERS = [
  ethers.getAddress("0x111111125421ca6dc452d289314280a0f8842a65"), // 1inch v6
  ethers.getAddress("0xdef1c0ded9bec7f1a1670819833240f027b25eff"), // 0x Exchange Proxy
  ethers.getAddress("0xdef171fe48cf0115b1d80b88dc8eab59176fee57"), // Paraswap Augustus v6
  ethers.getAddress("0xe592427a0aece92de3edee1f18e0157c05861564"), // Uniswap V3 SwapRouter
];

async function main() {
  console.log("══════════════════════════════════════════════════");
  console.log("  TeraSwapOrderExecutor v2 — Deploy");
  console.log("══════════════════════════════════════════════════\n");

  const network = await provider.getNetwork();
  console.log("Network:    ", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer:   ", wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log("Balance:    ", ethers.formatEther(balance), "ETH\n");

  if (balance === 0n) {
    console.error("❌ Deployer has no ETH for gas!");
    process.exit(1);
  }

  console.log("Constructor args:");
  console.log("  feeRecipient:", FEE_RECIPIENT);
  console.log("  admin:       ", ADMIN);
  console.log("  WETH:        ", WETH);
  console.log("");

  // ── Deploy ────────────────────────────────────────────────
  console.log("📦 Deploying contract...");
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(FEE_RECIPIENT, ADMIN, WETH);

  console.log("⏳ Tx sent:", contract.deploymentTransaction().hash);
  console.log("   Waiting for confirmation...\n");

  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("✅ Contract deployed at:", address);

  // ── Bootstrap (routers + executor) ────────────────────────
  console.log("\n📦 Bootstrapping routers and executor...");
  const tx = await contract.bootstrap(ROUTERS, [EXECUTOR]);
  console.log("⏳ Bootstrap tx:", tx.hash);
  await tx.wait();
  console.log("✅ Bootstrap complete!\n");

  // ── Summary ───────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════");
  console.log("  ✅ DEPLOYMENT COMPLETE");
  console.log("══════════════════════════════════════════════════");
  console.log("  Contract:      ", address);
  console.log("  Fee Recipient: ", FEE_RECIPIENT);
  console.log("  Admin:         ", ADMIN);
  console.log("  Executor:      ", EXECUTOR);
  console.log("  WETH:          ", WETH);
  console.log("  Routers:        4 whitelisted");
  console.log("══════════════════════════════════════════════════");
  console.log("\n📋 Next steps:");
  console.log(`  1. Update .env → NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS=${address}`);
  console.log(`  2. Update executor .env → ORDER_EXECUTOR_ADDRESS=${address}`);
  console.log("  3. Redeploy frontend on Vercel");
  console.log("  4. Restart executor process");
  console.log("  5. Verify on Etherscan (optional):");
  console.log(`     https://etherscan.io/address/${address}#code`);
}

main().catch((err) => {
  console.error("\n❌ Deploy failed:", err.message || err);
  process.exit(1);
});
