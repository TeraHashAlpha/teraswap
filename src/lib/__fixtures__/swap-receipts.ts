/**
 * [ADR-029] REAL transactions and receipts, captured, not synthesised: the verbatim answers of public nodes to
 * `eth_getTransactionByHash` and `eth_getTransactionReceipt`, read on 2026-11-25. Each file under ./swap-receipts/ is
 * `{ name, chainId, hash, endpoint, fetchedAt, tx, receipt }`; `endpoint` is the public node's origin (no key).
 * One node answered both reads of a pair.
 *
 * What they are (chain, kind, hash prefix):
 *   1      fee_collector  token -> token   0x300bf6aa   FeeCollector V2, router Augustus V6 (velora)
 *   1      fee_collector  token -> ETH     0x07286452   the bought ETH leaves no ERC-20 log; only SwapWithFee has it
 *   1      fee_collector  ETH -> token     0x846ef9ac   router KyberSwap
 *   1      fee_collector  V1, ETH -> token 0x9682c60f   the frozen V1 (5-argument event, no output in it)
 *   1      fee_collector  V1, reverted     0x8ef2f832
 *   1      router (0x)    token -> token   0xafdbe00b   0x AllowanceHolder
 *   1      router (0x)    reverted         0x853d5dd3
 *   1      router (0x)    value + token    0xae602328   the sender paid ETH AND sent USDT: two candidates on one side
 *   1      cow            direct           0xb4b8b53e   sent to the settlement contract, one Trade
 *   1      cow            via a solver     0x153ced87   sent to a solver's contract, which calls the settlement contract
 *   1      cow            two owners       0xd94893b5   one settlement, two wallets' trades
 *   8453   fee_collector  ETH -> token     0x5d336dce
 *   8453   fee_collector  token -> token   0xa8919634   router Uniswap SwapRouter02
 *   8453   router (0x)    token -> ETH     0xbc9aac55   nothing comes back as an ERC-20 leg
 *   8453   cow            direct           0x6b837155
 *   42161  fee_collector  token -> ETH     0xf14b181b   the transaction docs/DEPLOYMENTS.md names for the Arbitrum fee check
 *   42161  router (0x)    token -> token   0xac6565a1
 *   42161  cow            via a solver     0xcba5a096
 *   8453   router (uniswapv3) token -> token 0xfb357206  sent straight to Uniswap SwapRouter02 on Base (A103 S-8: the
 *                                                       only router fixture whose router differs per chain), read
 *                                                       2026-11-26 from mainnet.base.org
 *
 * The addresses in them are public chain data. No reverted transaction of ours exists on Base or Arbitrum.
 *
 * FORK_SWAP_RECEIPTS (goal 133b, A103 S-1, S-2, S-5): transactions sent on 2026-11-26 to a LOCAL anvil fork (127.0.0.1;
 * the fork read public state through mainnet.base.org, ethereum-rpc.publicnode.com and arb1.arbitrum.io; nothing was sent
 * to any real chain), saved verbatim as the fork's node answered them. Each file's `note` says what it is. The sender is
 * anvil's default account 0 (0xf39f…2266), except the smart-wallet one (bundler = anvil account 1).
 *   8453   SwapRouter02 multicall of N x [pull(WETH, 1e18), sweepToken(WETH, 1e18, wallet)], N = 1, 2, 50 (S-1)
 *   8453   a real WETH -> USDC exactInputSingle through the same router; a wrap alone; an unwrap alone; 1 ETH refunded
 *   1, 8453, 42161  the view TIMELOCK_DELAY() called as a transaction on that chain's FeeCollector (S-2)
 *   8453   WETH.approve(FeeCollector); a FeeCollector swap that reverts; a Multicall3 call whose inner FeeCollector call
 *          reverts while the transaction succeeds (S-2)
 *   8453   a Coinbase Smart Wallet (v1.1) swapping 0.05 ETH for USDC through the FeeCollector, the user operation sent
 *          by a bundler to the EntryPoint v0.6 (S-5)
 *
 * ROUND3_RECEIPTS (goal 133c, audit A104), NOT in EVERY_SWAP_RECEIPT (the tests that ask for them name them):
 *   1, 42161  REAL 0x swaps paying ETH for USDC (0x AllowanceHolder, the USDC sent to the payer), from round 1's sample
 *             of public-node answers read on 2026-11-25 (0x1ed2add5 on Ethereum, 0xa667ad70 on Arbitrum)
 *   8453      the same on Base (0x0a438d67, 0.0061 ETH for 10.33 USDC), read on 2026-11-26 from mainnet.base.org: round
 *             1's sample had no ETH-in 0x swap on Base; found by reading the latest 2,320 blocks
 *   1, 8453, 42161  the A104 auditor's "dust wrap" (a local anvil fork, 2026-11-26, sender 0xa104…a104): SwapRouter02
 *             multicall{value 20 ETH}[wrapETH(1e12 wei), sweepToken(WETH, 0, wallet), refundETH()]: 20 ETH paid, 19.999…
 *             refunded with no log, 1e12 wei of WETH received
 *   8453      the same auditor's "dust real swap": 20 ETH paid, 1e14 wei swapped for 0.17 USDC, the rest refunded
 * Saved verbatim as the nodes answered (the auditor's files and round 1's cache, copied unchanged).
 *
 * ROUND4_RECEIPTS (goal 133d, audit A106), NOT in EVERY_SWAP_RECEIPT either; the A106 auditor's files, copied unchanged:
 *   8453      a REAL 0x swap of a token for a token (0x86583c6e, AllowanceHolder, no ETH paid), read on 2026-11-27 from
 *             mainnet.base.org: the swap of the audit's R3-1 path
 *   1, 8453, 42161  the "half wrap" (a local anvil fork, 2026-11-27, sender 0xa106…a106): AllowanceHolder.exec{value 20
 *             ETH} into a contract that wraps 10 ETH for the sender and sends the other 10 back with no log (R3-2)
 *
 * A107_RECEIPTS (goal 139, audit A107 R4-1), NOT in EVERY_SWAP_RECEIPT either:
 *   1         a REAL 0x swap paying 0.006 ETH for 10.357597 USDT (0x9859bed7, AllowanceHolder, the USDT sent to the
 *             payer), read on 2026-11-27 from ethereum-rpc.publicnode.com by the round-3 auditor; its file
 *             real0x-1-eth-1.json, copied unchanged. The A107 probe priced it 10.80 / 10.36 (ETH at 1,800)
 */
import type { ChainRead, ChainReadMethod } from '@/lib/swap-verify/chain-read'
import mainnetRouterEthToToken from './swap-receipts/1-router-0x-eth-to-token.json'
import mainnetRouterEthToUsdt from './swap-receipts/1-router-0x-eth-to-usdt.json'
import baseRouterEthToToken from './swap-receipts/8453-router-0x-eth-to-token.json'
import arbitrumRouterEthToToken from './swap-receipts/42161-router-0x-eth-to-token.json'
import a104MainnetDustWrap from './swap-receipts/fork-1-a104-eth-refund-dust-wrap.json'
import a104BaseDustWrap from './swap-receipts/fork-8453-a104-eth-refund-dust-wrap.json'
import a104ArbitrumDustWrap from './swap-receipts/fork-42161-a104-eth-refund-dust-wrap.json'
import a104BaseDustSwap from './swap-receipts/fork-8453-a104-eth-refund-dust-swap.json'
import a106BaseRouterTokenToToken from './swap-receipts/8453-router-0x-token-to-token-a106.json'
import a106MainnetHalfWrap from './swap-receipts/fork-1-a106-ah-half-wrap.json'
import a106BaseHalfWrap from './swap-receipts/fork-8453-a106-ah-half-wrap.json'
import a106ArbitrumHalfWrap from './swap-receipts/fork-42161-a106-ah-half-wrap.json'
import mainnetFcTokenToToken from './swap-receipts/1-fee-collector-token-to-token.json'
import mainnetFcTokenToEth from './swap-receipts/1-fee-collector-token-to-eth.json'
import mainnetFcEthToToken from './swap-receipts/1-fee-collector-eth-to-token.json'
import mainnetFcV1EthToToken from './swap-receipts/1-fee-collector-v1-eth-to-token.json'
import mainnetFcV1Reverted from './swap-receipts/1-fee-collector-v1-reverted.json'
import mainnetRouterTokenToToken from './swap-receipts/1-router-0x-token-to-token.json'
import mainnetRouterReverted from './swap-receipts/1-router-0x-reverted.json'
import mainnetRouterValueAndToken from './swap-receipts/1-router-0x-value-and-token-out.json'
import mainnetCowDirect from './swap-receipts/1-cow-direct.json'
import mainnetCowViaSolver from './swap-receipts/1-cow-via-solver-contract.json'
import mainnetCowTwoOwners from './swap-receipts/1-cow-two-owners.json'
import baseFcEthToToken from './swap-receipts/8453-fee-collector-eth-to-token.json'
import baseFcTokenToToken from './swap-receipts/8453-fee-collector-token-to-token.json'
import baseRouterTokenToEth from './swap-receipts/8453-router-0x-token-to-eth.json'
import baseCowDirect from './swap-receipts/8453-cow-direct.json'
import arbitrumFcTokenToEth from './swap-receipts/42161-fee-collector-token-to-eth.json'
import arbitrumRouterTokenToToken from './swap-receipts/42161-router-0x-token-to-token.json'
import arbitrumCowViaSolver from './swap-receipts/42161-cow-via-solver-contract.json'
import baseRouterUniswapTokenToToken from './swap-receipts/8453-router-uniswapv3-token-to-token.json'
import forkPullSweep1 from './swap-receipts/fork-8453-router-uniswapv3-pull-sweep-x1.json'
import forkPullSweep2 from './swap-receipts/fork-8453-router-uniswapv3-pull-sweep-x2.json'
import forkPullSweep50 from './swap-receipts/fork-8453-router-uniswapv3-pull-sweep-x50.json'
import forkWethToUsdc from './swap-receipts/fork-8453-router-uniswapv3-weth-to-usdc.json'
import forkWrapAlone from './swap-receipts/fork-8453-router-uniswapv3-wrap-alone.json'
import forkUnwrapAlone from './swap-receipts/fork-8453-router-uniswapv3-unwrap-alone.json'
import forkEthRefund from './swap-receipts/fork-8453-router-uniswapv3-eth-refund.json'
import forkMainnetFcGetter from './swap-receipts/fork-1-fee-collector-getter-call.json'
import forkBaseFcGetter from './swap-receipts/fork-8453-fee-collector-getter-call.json'
import forkArbitrumFcGetter from './swap-receipts/fork-42161-fee-collector-getter-call.json'
import forkApprove from './swap-receipts/fork-8453-weth-approve-fee-collector.json'
import forkFcReverted from './swap-receipts/fork-8453-fee-collector-reverted.json'
import forkFcRevertsInside from './swap-receipts/fork-8453-fee-collector-reverts-inside.json'
import forkSmartWallet from './swap-receipts/fork-8453-fee-collector-smart-wallet-via-entrypoint.json'

export interface SwapReceiptFixture {
  name: string
  chainId: number
  hash: string
  endpoint: string
  fetchedAt: string
  tx: Record<string, unknown>
  receipt: Record<string, unknown> & { logs: Array<Record<string, unknown>> }
}

const as = (f: unknown): SwapReceiptFixture => f as SwapReceiptFixture

export const SWAP_RECEIPTS = {
  mainnetFcTokenToToken: as(mainnetFcTokenToToken),
  mainnetFcTokenToEth: as(mainnetFcTokenToEth),
  mainnetFcEthToToken: as(mainnetFcEthToToken),
  mainnetFcV1EthToToken: as(mainnetFcV1EthToToken),
  mainnetFcV1Reverted: as(mainnetFcV1Reverted),
  mainnetRouterTokenToToken: as(mainnetRouterTokenToToken),
  mainnetRouterReverted: as(mainnetRouterReverted),
  mainnetRouterValueAndToken: as(mainnetRouterValueAndToken),
  mainnetCowDirect: as(mainnetCowDirect),
  mainnetCowViaSolver: as(mainnetCowViaSolver),
  mainnetCowTwoOwners: as(mainnetCowTwoOwners),
  baseFcEthToToken: as(baseFcEthToToken),
  baseFcTokenToToken: as(baseFcTokenToToken),
  baseRouterTokenToEth: as(baseRouterTokenToEth),
  baseCowDirect: as(baseCowDirect),
  arbitrumFcTokenToEth: as(arbitrumFcTokenToEth),
  arbitrumRouterTokenToToken: as(arbitrumRouterTokenToToken),
  arbitrumCowViaSolver: as(arbitrumCowViaSolver),
  baseRouterUniswapTokenToToken: as(baseRouterUniswapTokenToToken),
} as const

/** The recorded real transactions (public nodes). */
export const ALL_SWAP_RECEIPTS: readonly SwapReceiptFixture[] = Object.values(SWAP_RECEIPTS)

/** Transactions sent to a local anvil fork (see the header). Not real chain transactions. */
export const FORK_RECEIPTS = {
  pullSweep1: as(forkPullSweep1),
  pullSweep2: as(forkPullSweep2),
  pullSweep50: as(forkPullSweep50),
  wethToUsdc: as(forkWethToUsdc),
  wrapAlone: as(forkWrapAlone),
  unwrapAlone: as(forkUnwrapAlone),
  ethRefund: as(forkEthRefund),
  mainnetFcGetter: as(forkMainnetFcGetter),
  baseFcGetter: as(forkBaseFcGetter),
  arbitrumFcGetter: as(forkArbitrumFcGetter),
  approve: as(forkApprove),
  fcReverted: as(forkFcReverted),
  fcRevertsInside: as(forkFcRevertsInside),
  smartWallet: as(forkSmartWallet),
} as const

export const FORK_SWAP_RECEIPTS: readonly SwapReceiptFixture[] = Object.values(FORK_RECEIPTS)

/** Both: what the stub RPC and the recorded chain read serve by default. */
export const EVERY_SWAP_RECEIPT: readonly SwapReceiptFixture[] = [...ALL_SWAP_RECEIPTS, ...FORK_SWAP_RECEIPTS]

/** Round 1's cached answers carry no `name`: it is given here. */
const named = (f: unknown, name: string): SwapReceiptFixture => ({ ...(f as SwapReceiptFixture), name })

/** Goal 133c (see the header): served only by the tests that pass them. */
export const ROUND3_RECEIPTS = {
  mainnetRouterEthToToken: named(mainnetRouterEthToToken, '1-router-0x-eth-to-token'),
  baseRouterEthToToken: as(baseRouterEthToToken),
  arbitrumRouterEthToToken: named(arbitrumRouterEthToToken, '42161-router-0x-eth-to-token'),
  a104MainnetDustWrap: as(a104MainnetDustWrap),
  a104BaseDustWrap: as(a104BaseDustWrap),
  a104ArbitrumDustWrap: as(a104ArbitrumDustWrap),
  a104BaseDustSwap: as(a104BaseDustSwap),
} as const

/** Goal 133d (see the header): served only by the tests that pass them. */
export const ROUND4_RECEIPTS = {
  baseRouterTokenToToken: as(a106BaseRouterTokenToToken),
  mainnetHalfWrap: as(a106MainnetHalfWrap),
  baseHalfWrap: as(a106BaseHalfWrap),
  arbitrumHalfWrap: as(a106ArbitrumHalfWrap),
} as const

/** Goal 139 (see the header): served only by the tests that pass it. */
export const A107_RECEIPTS = {
  mainnetRouterEthToUsdt: as(mainnetRouterEthToUsdt),
} as const

/** The A104 auditor's impersonated sender of its fork transactions. */
export const A104_FORK_WALLET = '0xa104a104a104a104a104a104a104a104a104a104'

/** The smart wallet of FORK_RECEIPTS.smartWallet (Coinbase Smart Wallet v1.1 on the Base fork). */
export const FORK_SMART_WALLET = '0x80c4a2bee98d15109e051af1124f2e92d06b7e7b'
/** anvil's default account 0: the sender of every other fork transaction. */
export const FORK_WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

/** The contracts the three chains had when the fixtures were read (docs/DEPLOYMENTS.md, the "Contracts" table). */
export const FIXTURE_FEE_COLLECTOR = {
  1: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459',
  8453: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
  42161: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
} as const

export interface RecordedChainRead {
  read: ChainRead
  /** Every read made, in order. */
  calls: Array<{ chainId: number; method: ChainReadMethod; hash: string }>
}

/**
 * A chain read that answers from recorded fixtures: a transaction exists only on the chain it was read from, exactly
 * as on the real chains. `overrides` replaces one answer (`null`, a changed copy, or an Error to throw).
 */
export function recordedChainRead(
  fixtures: readonly SwapReceiptFixture[] = EVERY_SWAP_RECEIPT,
  overrides: Partial<Record<ChainReadMethod, unknown>> = {},
): RecordedChainRead {
  const calls: RecordedChainRead['calls'] = []
  const read: ChainRead = async (chainId, method, params) => {
    const hash = String(params[0]).toLowerCase()
    calls.push({ chainId, method, hash })
    if (Object.prototype.hasOwnProperty.call(overrides, method)) {
      const override = overrides[method]
      if (override instanceof Error) throw override
      return override
    }
    const found = fixtures.find((f) => f.chainId === chainId && f.hash.toLowerCase() === hash)
    if (!found) return null
    return method === 'eth_getTransactionByHash' ? found.tx : found.receipt
  }
  return { read, calls }
}
