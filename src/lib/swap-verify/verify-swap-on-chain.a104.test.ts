// @vitest-environment node
/**
 * [goal 133c details S] Audit A104 on verifySwapOnChain and the chain read: N (kind router only for a DIRECT source's own
 * contract), the audit's dust receipts, Q.3 (a chain that returned the transaction is its chain) and Q.2 (every upstream
 * call paid before it is sent).
 *
 * Failing first: this file runs unchanged on cbd51bcf (round 2's last code commit) with the branch's fixtures copied in;
 * the tests marked [fails on cbd51bcf] fail there by assertion. The others are controls (what must still verify), each
 * proven by a named mutant (docs/feedback/…tables.md, Q5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
})

import { EVERY_SWAP_RECEIPT, ROUND3_RECEIPTS as R3, SWAP_RECEIPTS as R, recordedChainRead, type SwapReceiptFixture } from '@/lib/__fixtures__/swap-receipts'
import { getFeeIncompatibleSources } from '@/lib/chains/activation'
import { ROUTER_WHITELIST_BY_CHAIN } from '@/lib/chains/routers'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'
import { installStubChainRpc } from '@/test-utils/stub-chain-rpc'
import { ChainReadError, readChain } from './chain-read'
import { verifySwapOnChain, type VerifySwapResult } from './verify-swap-on-chain'

const ALL = [...EVERY_SWAP_RECEIPT, ...Object.values(R3)]
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const sender = (f: SwapReceiptFixture) => String(f.tx.from).toLowerCase()
const routerOf = (chainId: number, source: string) => ROUTER_WHITELIST_BY_CHAIN[chainId][source].toLowerCase()

/** The same transaction and receipt with the target moved (tx.to and receipt.to); logs unchanged: a built variant. */
function sentTo(f: SwapReceiptFixture, to: string): Parameters<typeof recordedChainRead>[1] {
  return { eth_getTransactionByHash: { ...structuredClone(f.tx), to }, eth_getTransactionReceipt: { ...structuredClone(f.receipt), to } }
}

async function verify(f: SwapReceiptFixture, wallet = sender(f), overrides: Parameters<typeof recordedChainRead>[1] = {}): Promise<VerifySwapResult> {
  // The round-1 `source` rides along (cbd51bcf ignores it too); the chain names the source.
  const input = Object.assign({ chainId: f.chainId, txHash: f.hash, wallet }, { source: '0x' })
  return verifySwapOnChain(input, { read: recordedChainRead(ALL, overrides).read })
}

/** A real 0x swap of each chain, sent by its wallet (as recorded: to the 0x AllowanceHolder). */
const REAL_0X: Array<[number, SwapReceiptFixture]> = [
  [1, R.mainnetRouterTokenToToken],
  [8453, R.baseRouterTokenToEth],
  [42161, R.arbitrumRouterTokenToToken],
]

describe('N: kind router only for a direct source (0x, bebop), at that source\'s own contract', () => {
  it('the direct sources are the fee-incompatible ones minus cowswap: 0x and bebop on the three chains (the list the code reads)', () => {
    for (const chainId of [1, 8453, 42161]) {
      expect(getFeeIncompatibleSources(chainId).filter((s) => s !== 'cowswap').sort()).toEqual(['0x', 'bebop'])
      // The contract each is held to: the 0x AllowanceHolder and Bebop's JamSettlement, the same address on every chain.
      expect(routerOf(chainId, '0x')).toBe('0x0000000000001ff3684f28c67538d4d072c22734')
      expect(routerOf(chainId, 'bebop')).toBe('0xbeb0b0623f66be8ce162ebdfa2ec543a522f4ea6')
    }
  })

  // There each was confirmed as that router's source.
  for (const [chainId, f] of REAL_0X) {
    it.each(['uniswapv3', 'kyberswap', 'velora'])(`chain ${chainId}: a real net swap sent to %s's router is rejected not_direct_source [fails on cbd51bcf]`, async (source) => {
      expect(await verify(f, sender(f), sentTo(f, routerOf(chainId, source)))).toEqual({ outcome: 'rejected', reason: 'not_direct_source' })
    })
  }

  it.each([1, 8453, 42161])('chain %i: a router of cowswap (its VaultRelayer) is not a direct target either [fails on cbd51bcf]', async (chainId) => {
    const f = REAL_0X.find(([c]) => c === chainId)![1]
    expect(await verify(f, sender(f), sentTo(f, routerOf(chainId, 'cowswap')))).toEqual({ outcome: 'rejected', reason: 'not_direct_source' })
  })

  it.each(REAL_0X)('chain %i control: the same real swap as recorded (to the 0x AllowanceHolder) is confirmed as 0x', async (_chainId, f) => {
    expect(await verify(f)).toMatchObject({ outcome: 'confirmed', kind: 'router', derived: { source: '0x' } })
  })

  it.each(REAL_0X)('chain %i control: the same logs sent to Bebop\'s JamSettlement are confirmed as bebop', async (chainId, f) => {
    expect(await verify(f, sender(f), sentTo(f, routerOf(chainId, 'bebop')))).toMatchObject({ outcome: 'confirmed', kind: 'router', derived: { source: 'bebop' } })
  })

  it('a reverted call to SwapRouter02 is not a failed swap: rejected not_direct_source [fails on cbd51bcf]; to 0x it stays failed', async () => {
    const f = R.mainnetRouterReverted
    expect(await verify(f, sender(f), sentTo(f, routerOf(1, 'uniswapv3')))).toEqual({ outcome: 'rejected', reason: 'not_direct_source' })
    expect(await verify(f)).toMatchObject({ outcome: 'failed', kind: 'router', derived: { source: '0x' } })
  })

  it('a contract no source lists stays wrong_target (not_direct_source names only another source\'s router)', async () => {
    const f = R.mainnetRouterTokenToToken
    expect(await verify(f, sender(f), sentTo(f, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'))).toEqual({ outcome: 'rejected', reason: 'wrong_target' })
  })
})

describe('A104 R2-1: the audit\'s dust receipts (ETH paid, almost all of it refunded with no log)', () => {
  const DUST: Array<[string, SwapReceiptFixture]> = [
    ['Ethereum dust wrap', R3.a104MainnetDustWrap],
    ['Base dust wrap', R3.a104BaseDustWrap],
    ['Arbitrum dust wrap', R3.a104ArbitrumDustWrap],
    ['Base dust real swap', R3.a104BaseDustSwap],
  ]

  it.each(DUST)('%s, as sent (to SwapRouter02): rejected not_direct_source [fails on cbd51bcf]', async (_name, f) => {
    expect(BigInt(String(f.tx.value))).toBe(20n * 10n ** 18n)
    expect(await verify(f)).toEqual({ outcome: 'rejected', reason: 'not_direct_source' })
  })

  it.each(DUST)('%s, its logs sent to 0x: the chain still says "20 ETH in" (the USD band of O decides, in confirm.ts)', async (_name, f) => {
    const result = await verify(f, sender(f), sentTo(f, routerOf(f.chainId, '0x')))
    expect(result).toMatchObject({ outcome: 'confirmed', kind: 'router', derived: { tokenIn: NATIVE, amountIn: '20000000000000000000', source: '0x' } })
    expect(result.derived?.tokenOut).not.toBeNull()
  })
})

describe('Q.3: a chain that returned the transaction is its chain', () => {
  it.each(['receipt read error', 'receipt missing', 'receipt unreadable'] as const)('%s: not_found, and the answer says the transaction was found [fails on cbd51bcf]', async (kind) => {
    const f = R.mainnetFcTokenToToken
    const receipt = kind === 'receipt read error' ? new ChainReadError('rpc_error') : kind === 'receipt missing' ? null : { status: '0x7' }
    const result = await verify(f, sender(f), { eth_getTransactionReceipt: receipt })
    expect(result).toMatchObject({ outcome: 'not_found', txFound: true })
  })

  it('a transaction read error or a missing transaction does not say so (the next chain may have it)', async () => {
    const f = R.mainnetFcTokenToToken
    expect(await verify(f, sender(f), { eth_getTransactionByHash: new ChainReadError('rpc_error') })).toEqual({ outcome: 'not_found', reason: 'rpc_error' })
    expect(await verify(f, sender(f), { eth_getTransactionByHash: null })).toEqual({ outcome: 'not_found', reason: 'tx_missing' })
  })
})

describe('Q.2: every upstream call of a read is paid before it is sent', () => {
  let rpc: ReturnType<typeof installStubChainRpc>
  beforeEach(() => {
    for (const name of ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL']) delete process.env[name]
    __resetChainIdentityCache()
    rpc = installStubChainRpc()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const f = R.mainnetFcTokenToToken
  /** A budget of `n` calls; counts what it was asked. */
  function budget(n: number) {
    const asked = { count: 0 }
    const pay = async () => {
      asked.count++
      return asked.count <= n
    }
    return { asked, pay }
  }
  const call = (pay: () => Promise<boolean>) => (readChain as unknown as (...a: unknown[]) => Promise<unknown>)(1, 'eth_getTransactionByHash', [f.hash], { beforeUpstream: pay })

  it('a refused first call sends nothing: read_budget [fails on cbd51bcf]', async () => {
    const { asked, pay } = budget(0)
    await expect(call(pay)).rejects.toMatchObject({ code: 'read_budget' })
    expect(asked.count).toBe(1)
    expect(rpc.calls).toEqual([])
  })

  it('the chain-id proof is paid when it is not cached, and not when it is; each call is paid once [fails on cbd51bcf]', async () => {
    const first = budget(10)
    expect(await call(first.pay)).toMatchObject({ hash: f.hash })
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_getTransactionByHash'])
    expect(first.asked.count).toBe(2)
    rpc.reset()
    const second = budget(10)
    await call(second.pay)
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_getTransactionByHash'])
    expect(second.asked.count).toBe(1)
  })

  it('a refused chain-id proof is not cached as an outage: the next caller with budget reads normally [fails on cbd51bcf]', async () => {
    await expect(call(budget(0).pay)).rejects.toMatchObject({ code: 'read_budget' })
    expect(await (readChain as unknown as (...a: unknown[]) => Promise<unknown>)(1, 'eth_getTransactionByHash', [f.hash])).toMatchObject({ hash: f.hash })
  })

  it('a null answer\'s re-ask is a second paid call: refused, the read ends with read_budget [fails on cbd51bcf]', async () => {
    vi.unstubAllGlobals()
    rpc = installStubChainRpc({ fixtures: [] })
    const { asked, pay } = budget(2)
    await expect(call(pay)).rejects.toMatchObject({ code: 'read_budget' })
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_getTransactionByHash'])
    expect(asked.count).toBe(3)
  })

  it('verifySwapOnChain hands its budget to both reads: a refused receipt read is not_found read_budget, the transaction found [fails on cbd51bcf]', async () => {
    const { pay } = budget(2)
    const result = await verifySwapOnChain({ chainId: 1, txHash: f.hash, wallet: sender(f) }, { beforeUpstream: pay } as never)
    expect(result).toEqual({ outcome: 'not_found', reason: 'read_budget', txFound: true })
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_getTransactionByHash'])
  })
})
