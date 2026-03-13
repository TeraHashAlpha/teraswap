/**
 * Deploy TeraSwapOrderExecutor v2 to Ethereum mainnet
 *
 * Usage:
 *   cd contracts/order-engine
 *   npx hardhat run scripts/deploy.cjs --network mainnet
 *
 * Required env vars (in .env or exported):
 *   DEPLOYER_PRIVATE_KEY  — Private key of the deployer wallet
 *   RPC_URL               — Ethereum mainnet RPC (Alchemy/Infura)
 *   ETHERSCAN_API_KEY     — (optional) For contract verification
 *
 * Constructor args:
 *   _feeRecipient — Address that receives the 0.1% swap fee
 *   _admin        — Admin address (manages router whitelist, emergency pause)
 *   _weth         — WETH address (0xC02aaA39b223FE8D0A6e5c4F27eAD9083C756Cc2 on mainnet)
 */

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  // ── Constructor parameters ──────────────────────────────────
  // IMPORTANT: Change these to your actual addresses!
  const FEE_RECIPIENT = process.env.FEE_RECIPIENT || deployer.address;
  const ADMIN         = process.env.ADMIN_ADDRESS || deployer.address;
  const WETH          = "0xC02aaA39b223FE8D0A6e5c4F27eAD9083C756Cc2"; // Mainnet WETH

  console.log("\nConstructor args:");
  console.log("  feeRecipient:", FEE_RECIPIENT);
  console.log("  admin:       ", ADMIN);
  console.log("  WETH:        ", WETH);

  // ── Deploy ──────────────────────────────────────────────────
  console.log("\nDeploying TeraSwapOrderExecutor...");
  const Factory = await ethers.getContractFactory("TeraSwapOrderExecutor");
  const contract = await Factory.deploy(FEE_RECIPIENT, ADMIN, WETH);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\n✅ TeraSwapOrderExecutor deployed at:", address);

  // ── Bootstrap routers + executor ────────────────────────────
  console.log("\nBootstrapping routers and executor...");

  const ROUTERS = [
    "0x111111125421cA6dc452d289314280a0f8842A65", // 1inch v6
    "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", // 0x Exchange Proxy
    "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57", // Paraswap Augustus v6
    "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3 SwapRouter
  ];

  // The executor address — replace with your executor wallet
  const EXECUTOR = process.env.EXECUTOR_ADDRESS || deployer.address;

  const tx = await contract.bootstrap(ROUTERS, [EXECUTOR]);
  await tx.wait();
  console.log("✅ Bootstrap complete — routers and executor whitelisted");

  // ── Summary ─────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════");
  console.log("  DEPLOYMENT COMPLETE");
  console.log("══════════════════════════════════════════════════");
  console.log("  Contract:      ", address);
  console.log("  Fee Recipient: ", FEE_RECIPIENT);
  console.log("  Admin:         ", ADMIN);
  console.log("  Executor:      ", EXECUTOR);
  console.log("  WETH:          ", WETH);
  console.log("  Routers:        4 whitelisted");
  console.log("══════════════════════════════════════════════════");
  console.log("\n📋 Next steps:");
  console.log("  1. Update NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS in .env →", address);
  console.log("  2. Update ORDER_EXECUTOR_ADDRESS in executor .env →", address);
  console.log("  3. Redeploy frontend (Vercel)");
  console.log("  4. Restart executor process");
  console.log("  5. Users must re-create DCA orders (old contract signatures won't work)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deploy failed:", error);
    process.exit(1);
  });
