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
 *
 * The addresses in them are public chain data. No reverted transaction of ours exists on Base or Arbitrum.
 */
import type { ChainRead, ChainReadMethod } from '@/lib/swap-verify/chain-read'
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
} as const

export const ALL_SWAP_RECEIPTS: readonly SwapReceiptFixture[] = Object.values(SWAP_RECEIPTS)

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
  fixtures: readonly SwapReceiptFixture[] = ALL_SWAP_RECEIPTS,
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
