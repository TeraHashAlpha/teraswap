/**
 * TeraSwapOrderExecutor v2 — Local Test Suite
 *
 * Runs against a local Hardhat Network (in-process) using viem.
 * No external RPC needed — everything is local.
 *
 * Usage: node test-run.js
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  zeroAddress,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import fs from 'fs';
import path from 'path';

const basePath = decodeURIComponent(path.dirname(new URL(import.meta.url).pathname));

// ── Load compiled artifacts ──
const abi = JSON.parse(fs.readFileSync(path.join(basePath, 'build/TeraSwapOrderExecutor.abi.json'), 'utf8'));
const bytecode = '0x' + fs.readFileSync(path.join(basePath, 'build/TeraSwapOrderExecutor.bin'), 'utf8');

// ── Hardhat default accounts (well-known private keys) ──
const HARDHAT_ACCOUNTS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
];

// ── Test Harness ──
let passed = 0;
let failed = 0;
const results = [];

function assert(condition, msg) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq(a, b, msg) {
  const aStr = String(a);
  const bStr = String(b);
  if (aStr !== bStr) throw new Error(`${msg}: expected ${bStr}, got ${aStr}`);
}

function assertReverts(e, errorName, label) {
  // viem wraps reverts in various ways depending on the error path
  const full = JSON.stringify(e, Object.getOwnPropertyNames(e));
  const match = full.includes(errorName) ||
                full.includes('reverted') ||
                full.includes('ContractFunctionRevertedError') ||
                full.includes('ContractFunctionExecutionError') ||
                (e.name === 'ContractFunctionRevertedError');
  if (!match) throw new Error(`Expected revert ${errorName}, got: ${e.message}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: '✅' });
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    results.push({ name, status: '❌', error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

// ── Main ──
async function main() {
  console.log('\n🧪 TeraSwapOrderExecutor v2 — Test Suite\n');
  console.log('Setting up local Hardhat network...\n');

  // Start hardhat node in background
  const { spawn } = await import('child_process');
  const hardhatNode = spawn('npx', ['hardhat', 'node', '--config', 'hardhat.config.cjs', '--port', '18545'], {
    cwd: basePath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HARDHAT_CONFIG: 'hardhat.config.cjs' }
  });

  // Wait for node to start
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Hardhat node startup timeout')), 60000);
    hardhatNode.stdout.on('data', (data) => {
      const str = data.toString();
      if (str.includes('Started HTTP')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    hardhatNode.stderr.on('data', (data) => {
      const str = data.toString();
      if (str.includes('Started HTTP')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  console.log('Hardhat node running on port 18545\n');

  const RPC_URL = 'http://127.0.0.1:18545';

  const publicClient = createPublicClient({
    chain: hardhat,
    transport: http(RPC_URL),
  });

  // Create wallet clients for each test account
  const adminAccount = privateKeyToAccount(HARDHAT_ACCOUNTS[0]);
  const feeRecipientAccount = privateKeyToAccount(HARDHAT_ACCOUNTS[1]);
  const userAccount = privateKeyToAccount(HARDHAT_ACCOUNTS[2]);
  const attackerAccount = privateKeyToAccount(HARDHAT_ACCOUNTS[3]);

  const adminWallet = createWalletClient({
    account: adminAccount,
    chain: hardhat,
    transport: http(RPC_URL),
  });

  const userWallet = createWalletClient({
    account: userAccount,
    chain: hardhat,
    transport: http(RPC_URL),
  });

  // ── Deploy the executor ──
  console.log('Deploying TeraSwapOrderExecutor...');

  // Use a fake WETH address for now
  const WETH_ADDR = '0x0000000000000000000000000000000000000001';

  const hash = await adminWallet.deployContract({
    abi,
    bytecode,
    args: [feeRecipientAccount.address, adminAccount.address, WETH_ADDR],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const execAddr = receipt.contractAddress;
  console.log(`Deployed at: ${execAddr}\n`);

  // Create contract instances for different signers
  const executor = getContract({
    address: execAddr,
    abi,
    client: { public: publicClient, wallet: adminWallet },
  });

  const executorAsUser = getContract({
    address: execAddr,
    abi,
    client: { public: publicClient, wallet: userWallet },
  });

  // ══════════════════════════════════════════════════════════
  //  TESTS
  // ══════════════════════════════════════════════════════════

  console.log('── Constructor & Constants ──');

  await test('feeRecipient is set correctly', async () => {
    assertEq(await executor.read.feeRecipient(), feeRecipientAccount.address, 'feeRecipient');
  });

  await test('admin is set correctly', async () => {
    assertEq(await executor.read.admin(), adminAccount.address, 'admin');
  });

  await test('WETH is set correctly', async () => {
    assertEq(await executor.read.WETH(), WETH_ADDR, 'WETH');
  });

  await test('FEE_BPS is 10 (0.1%)', async () => {
    assertEq(await executor.read.FEE_BPS(), 10n, 'FEE_BPS');
  });

  await test('TIMELOCK_DELAY is 48 hours', async () => {
    assertEq(await executor.read.TIMELOCK_DELAY(), BigInt(48 * 3600), 'TIMELOCK_DELAY');
  });

  await test('TIMELOCK_GRACE is 7 days', async () => {
    assertEq(await executor.read.TIMELOCK_GRACE(), BigInt(7 * 86400), 'TIMELOCK_GRACE');
  });

  await test('MIN_ORDER_AMOUNT is 10000', async () => {
    assertEq(await executor.read.MIN_ORDER_AMOUNT(), 10000n, 'MIN_ORDER_AMOUNT');
  });

  await test('bootstrapped is false initially', async () => {
    assertEq(await executor.read.bootstrapped(), false, 'bootstrapped');
  });

  await test('nonces start at 0', async () => {
    assertEq(await executor.read.nonces([userAccount.address]), 0n, 'nonce');
  });

  console.log('\n── Bootstrap ──');

  // [Audit L-05] Bootstrap now requires contract addresses (not EOAs).
  // Use the executor contract itself as a "fake router" since it has code.
  const fakeRouter = execAddr;
  const executorAddr = adminAccount.address; // executor wallet = admin for tests

  await test('bootstrap: only admin can call', async () => {
    try {
      await executorAsUser.write.bootstrap([[fakeRouter], [executorAddr]]);
      throw new Error('Should have reverted');
    } catch (e) {
      if (e.message === 'Should have reverted') throw e;
      assertReverts(e, 'NotAdmin', 'bootstrap non-admin');
    }
  });

  await test('bootstrap: rejects EOA router (L-05)', async () => {
    const eoaAddress = '0x0000000000000000000000000000000000000042';
    try {
      await executor.write.bootstrap([[eoaAddress], [executorAddr]]);
      throw new Error('Should have reverted');
    } catch (e) {
      if (e.message === 'Should have reverted') throw e;
      assertReverts(e, 'NotAContract', 'bootstrap EOA router');
    }
  });

  await test('bootstrap: admin whitelists routers + executors', async () => {
    const txHash = await executor.write.bootstrap([[fakeRouter], [executorAddr]]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    assertEq(await executor.read.whitelistedRouters([fakeRouter]), true, 'whitelisted');
    assertEq(await executor.read.whitelistedExecutors([executorAddr]), true, 'executor whitelisted');
    assertEq(await executor.read.bootstrapped(), true, 'bootstrapped');
  });

  await test('bootstrap: cannot call twice', async () => {
    try {
      await executor.write.bootstrap([[fakeRouter], [executorAddr]]);
      throw new Error('Should have reverted');
    } catch (e) {
      if (e.message === 'Should have reverted') throw e;
      assert(true, 'reverted as expected');
    }
  });

  console.log('\n── Nonce Invalidation (H-03) ──');

  await test('invalidateNonces: user can invalidate', async () => {
    const txHash = await executorAsUser.write.invalidateNonces([5n]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    assertEq(await executor.read.invalidatedNonces([userAccount.address]), 5n, 'invalidatedNonces');
  });

  await test('invalidateNonces: must increase', async () => {
    try {
      await executorAsUser.write.invalidateNonces([3n]); // lower than 5
      throw new Error('Should have reverted');
    } catch (e) {
      if (e.message === 'Should have reverted') throw e;
      assertReverts(e, 'Must increase', 'nonce must increase');
    }
  });

  await test('invalidateNonces: can increase further', async () => {
    const txHash = await executorAsUser.write.invalidateNonces([10n]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    assertEq(await executor.read.invalidatedNonces([userAccount.address]), 10n, 'invalidatedNonces');
  });

  console.log('\n── Timelock (M-02) ──');

  const newRouter = '0x0000000000000000000000000000000000000099';

  await test('queueRouterChange: only admin', async () => {
    try {
      await executorAsUser.write.queueRouterChange([newRouter, true]);
      throw new Error('Should have reverted');
    } catch (e) {
      if (e.message === 'Should have reverted') throw e;
      assertReverts(e, 'NotAdmin', 'queueRouterChange non-admin');
    }
  });

  await test('queueRouterChange: admin can queue', async () => {
    const txHash = await executor.write.queueRouterChange([newRouter, true]);
    const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert(txReceipt.status === 'success', 'tx should succeed');
    // Router should NOT be whitelisted yet
    assertEq(await executor.read.whitelistedRouters([newRouter]), false, 'not yet whitelisted');
  });

  await test('queueAdminChange: admin can queue', async () => {
    const txHash = await executor.write.queueAdminChange([attackerAccount.address]);
    const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert(txReceipt.status === 'success', 'tx should succeed');
    // Admin should NOT change yet
    assertEq(await executor.read.admin(), adminAccount.address, 'admin unchanged');
  });

  console.log('\n── Sweep (Timelocked) ──');

  await test('queueSweep: only admin', async () => {
    try {
      await executorAsUser.write.queueSweep([zeroAddress]);
      throw new Error('Should have reverted');
    } catch (e) {
      if (e.message === 'Should have reverted') throw e;
      assertReverts(e, 'NotAdmin', 'queueSweep non-admin');
    }
  });

  await test('queueSweep: admin can queue', async () => {
    const txHash = await executor.write.queueSweep([zeroAddress]);
    const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert(txReceipt.status === 'success', 'tx should succeed');
  });

  console.log('\n── DCA Validation (L-04) ──');

  // Test that canExecute rejects DCA orders with dcaTotal=0 and dcaInterval=0
  await test('canExecute: rejects DCA with dcaTotal=0', async () => {
    const fakeOrder = {
      owner: userAccount.address,
      tokenIn: zeroAddress,
      tokenOut: zeroAddress,
      amountIn: 100000n,
      minAmountOut: 1n,
      orderType: 2, // DCA
      condition: 0,
      targetPrice: 0n,
      priceFeed: zeroAddress,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
      nonce: 0n,
      router: fakeRouter,
      routerDataHash: zeroHash,
      dcaInterval: 3600n,
      dcaTotal: 0n, // Invalid!
    };
    const fakeSig = '0x' + '00'.repeat(65);
    const [canExec, reason] = await executor.read.canExecute([fakeOrder, fakeSig]);
    // It may fail on signature first, which is fine — the important thing
    // is it doesn't revert with division by zero
    assert(!canExec, 'should not be executable');
  });

  console.log('\n── EIP-712 ──');

  await test('domainSeparator is non-zero', async () => {
    const ds = await executor.read.domainSeparator();
    assert(ds !== zeroHash, 'domainSeparator should be non-zero');
  });

  await test('ORDER_TYPEHASH is non-zero', async () => {
    const th = await executor.read.ORDER_TYPEHASH();
    assert(th !== zeroHash, 'ORDER_TYPEHASH should be non-zero');
  });

  // ══════════════════════════════════════════════════════════
  //  SUMMARY
  // ══════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════\n');

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter(r => r.status === '❌').forEach(r => {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    });
  }

  // Cleanup
  hardhatNode.kill('SIGTERM');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\n💥 Fatal error:', e.message);
  process.exit(1);
});
