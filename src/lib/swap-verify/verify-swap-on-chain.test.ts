// @vitest-environment node
/**
 * [ADR-029, details A and G] verifySwapOnChain on REAL receipts (src/lib/__fixtures__/swap-receipts.ts): per kind and
 * chain, confirmed, reverted, wrong sender, wrong target, unknown source, missing receipt, the CoW trade of another
 * owner, two tokens on one side. Every expected token and amount below was read from the recorded receipt itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The registry reads the Base and Arbitrum FeeCollector from the environment when it is first imported
// (chains/registry.ts:80, :131), so the three deployed addresses are set before any import.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
})

import {
  ALL_SWAP_RECEIPTS,
  FIXTURE_FEE_COLLECTOR,
  SWAP_RECEIPTS as R,
  recordedChainRead,
  type SwapReceiptFixture,
} from '@/lib/__fixtures__/swap-receipts'
import { ChainReadError } from './chain-read'
import {
  NATIVE_PLACEHOLDER,
  cowSettlementOf,
  feeCollectorsOf,
  routerOf,
  sourceOfRouter,
  verifySwapOnChain,
  type VerifySwapInput,
} from './verify-swap-on-chain'

const sender = (f: SwapReceiptFixture) => String(f.tx.from)
const OTHER_WALLET = '0x00000000000000000000000000000000000000aa'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const ARB_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'

function input(f: SwapReceiptFixture, wallet: string, source: string, chainId = f.chainId): VerifySwapInput {
  return { chainId, txHash: f.hash, wallet, source }
}

async function verify(f: SwapReceiptFixture, wallet: string, source: string, chainId = f.chainId) {
  const chain = recordedChainRead()
  const result = await verifySwapOnChain(input(f, wallet, source, chainId), { read: chain.read })
  return { result, calls: chain.calls }
}

describe('the fixtures are what the header says', () => {
  it('each recorded transaction was sent to the contract its kind names, on its own chain', () => {
    expect(ALL_SWAP_RECEIPTS).toHaveLength(18)
    for (const f of ALL_SWAP_RECEIPTS) {
      expect(String(f.tx.hash).toLowerCase()).toBe(f.hash.toLowerCase())
      expect(String(f.receipt.transactionHash).toLowerCase()).toBe(f.hash.toLowerCase())
      expect(f.endpoint).toMatch(/^https:\/\/[a-z0-9.-]+$/)
    }
    expect(feeCollectorsOf(1)).toEqual({
      current: FIXTURE_FEE_COLLECTOR[1].toLowerCase(),
      v1: '0x4daeaf24cd300a3dbc0caff3292b7840cdda58ed',
    })
    expect(feeCollectorsOf(8453)).toEqual({ current: FIXTURE_FEE_COLLECTOR[8453].toLowerCase(), v1: null })
    expect(feeCollectorsOf(42161)).toEqual({ current: FIXTURE_FEE_COLLECTOR[42161].toLowerCase(), v1: null })
    for (const chainId of [1, 8453, 42161]) expect(cowSettlementOf(chainId)).toBe('0x9008d19f58aabd9ed0d60971565aa8510560ab41')
    expect(cowSettlementOf(10)).toBeNull()
    expect(routerOf(1, '0x')).toBe('0x0000000000001ff3684f28c67538d4d072c22734')
    expect(routerOf(1, 'uniswap')).toBeNull()
    expect(routerOf(10, '0x')).toBeNull()
    expect(routerOf(1, '__proto__')).toBeNull()
  })
})

describe('A.1 input: anything that is not ours is rejected with NO chain read', () => {
  const good = input(R.mainnetFcTokenToToken, sender(R.mainnetFcTokenToToken), 'velora')
  const cases: Array<[string, Partial<Record<keyof VerifySwapInput, unknown>>, string]> = [
    ['a chain the app does not have', { chainId: 10 }, 'bad_chain'],
    ['a chain id given as text', { chainId: '1' }, 'bad_chain'],
    ['a fractional chain id', { chainId: 1.5 }, 'bad_chain'],
    ['NaN as chain id', { chainId: Number.NaN }, 'bad_chain'],
    ['a short hash', { txHash: '0x1234' }, 'bad_tx_hash'],
    ['a hash with a non-hex character', { txHash: `0x${'g'.repeat(64)}` }, 'bad_tx_hash'],
    ['a hash with a 0X prefix', { txHash: `0X${'a'.repeat(64)}` }, 'bad_tx_hash'],
    ['a hash followed by a newline and text', { txHash: `0x${'a'.repeat(64)}\nconfirmed` }, 'bad_tx_hash'],
    ['a hash that is not a string', { txHash: 5 }, 'bad_tx_hash'],
    ['a wallet that is too short', { wallet: '0x1234' }, 'bad_wallet'],
    ['a wallet that is not a string', { wallet: null }, 'bad_wallet'],
    ['a source the app does not have', { source: 'paraswap' }, 'bad_source'],
    ['an XSS string as source', { source: '<img src=x onerror=alert(1)>' }, 'bad_source'],
    ['__proto__ as source', { source: '__proto__' }, 'bad_source'],
    ['constructor as source', { source: 'constructor' }, 'bad_source'],
    ['toString as source', { source: 'toString' }, 'bad_source'],
    ['a source that is not a string', { source: 1 }, 'bad_source'],
  ]
  it.each(cases)('%s', async (_name, change, reason) => {
    const chain = recordedChainRead()
    const result = await verifySwapOnChain({ ...good, ...change } as VerifySwapInput, { read: chain.read })
    expect(result).toEqual({ outcome: 'rejected', reason })
    expect(chain.calls).toEqual([])
  })
})

describe('kind fee_collector: tx.to is that chain\'s FeeCollector and tx.from is the wallet', () => {
  it('Ethereum, token to token: both sides from the FeeCollector\'s SwapWithFee event', async () => {
    const f = R.mainnetFcTokenToToken
    const { result, calls } = await verify(f, sender(f), 'velora')
    expect(result).toEqual({
      outcome: 'confirmed',
      kind: 'fee_collector',
      derived: {
        tokenIn: '0x5086bf358635b81d8c47c66d1c8b9e567db70c72',
        amountIn: '46080134130180921522',
        tokenOut: USDC,
        amountOut: '51012637',
        source: 'velora',
        gasUsed: BigInt(String(f.receipt.gasUsed)).toString(),
        gasPrice: BigInt(String(f.receipt.effectiveGasPrice)).toString(),
      },
    })
    expect(calls.map((c) => c.method)).toEqual(['eth_getTransactionByHash', 'eth_getTransactionReceipt'])
    expect(calls.every((c) => c.chainId === 1)).toBe(true)
  })

  it('Ethereum, token to ETH: the bought ETH has no ERC-20 log, the event has it (native placeholder)', async () => {
    const f = R.mainnetFcTokenToEth
    const { result } = await verify(f, sender(f), 'velora')
    expect(result.outcome).toBe('confirmed')
    expect(result.kind).toBe('fee_collector')
    expect(result.derived).toMatchObject({
      tokenIn: '0x5086bf358635b81d8c47c66d1c8b9e567db70c72',
      amountIn: '102247067011081778693',
      tokenOut: NATIVE_PLACEHOLDER,
      amountOut: '50428014210987008',
      source: 'velora',
    })
  })

  it('Ethereum, ETH to token: the sold ETH is the event\'s totalAmount (equal to tx.value)', async () => {
    const f = R.mainnetFcEthToToken
    const { result } = await verify(f, sender(f), 'kyberswap')
    expect(result.outcome).toBe('confirmed')
    expect(result.derived).toMatchObject({
      tokenIn: NATIVE_PLACEHOLDER,
      amountIn: '50000000000000000',
      tokenOut: WETH,
      amountOut: '49950000000000000',
      source: 'kyberswap',
    })
    expect(BigInt(String(f.tx.value)).toString()).toBe('50000000000000000')
  })

  it('the source of a FeeCollector row is the source whose router the FeeCollector call names, not the caller\'s', async () => {
    // This real swap went through Augustus V6 (velora). A row that says 1inch is corrected; one that says velora keeps it.
    const f = R.mainnetFcTokenToToken
    expect((await verify(f, sender(f), '1inch')).result.derived?.source).toBe('velora')
    expect((await verify(f, sender(f), 'cowswap')).result.derived?.source).toBe('velora')
    expect((await verify(f, sender(f), 'velora')).result.derived?.source).toBe('velora')
    expect(sourceOfRouter(1, '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', '1inch')).toBe('kyberswap')
    expect(sourceOfRouter(1, '0x00000000000000000000000000000000000000ff', '1inch')).toBe('unknown')
    expect(sourceOfRouter(10, '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5')).toBe('unknown')
  })

  it('Ethereum, the frozen V1: kind fee_collector; its event has no output, so the sides follow the Transfer-leg rule', async () => {
    const f = R.mainnetFcV1EthToToken
    const { result } = await verify(f, sender(f), 'uniswapv3')
    expect(result).toMatchObject({
      outcome: 'confirmed',
      kind: 'fee_collector',
      derived: {
        tokenIn: NATIVE_PLACEHOLDER,
        amountIn: '5000000000000000',
        tokenOut: '0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb',
        amountOut: '17812058682812979462',
        source: 'uniswapv3',
      },
    })
  })

  it('Ethereum, a reverted FeeCollector transaction: failed, nothing moved, both sides null', async () => {
    const f = R.mainnetFcV1Reverted
    const { result, calls } = await verify(f, sender(f), 'uniswapv3')
    expect(result.outcome).toBe('failed')
    expect(result.kind).toBe('fee_collector')
    expect(result.derived).toMatchObject({ tokenIn: null, amountIn: null, tokenOut: null, amountOut: null })
    expect(result.derived?.gasUsed).toBe(BigInt(String(f.receipt.gasUsed)).toString())
    expect(calls).toHaveLength(2)
  })

  it('Base: ETH to token and token to token', async () => {
    const a = R.baseFcEthToToken
    expect((await verify(a, sender(a), 'velora')).result).toMatchObject({
      outcome: 'confirmed',
      kind: 'fee_collector',
      derived: { tokenIn: NATIVE_PLACEHOLDER, amountIn: '115800000000000000', tokenOut: BASE_USDC, amountOut: '209199042', source: 'velora' },
    })
    const b = R.baseFcTokenToToken
    expect((await verify(b, sender(b), 'kyberswap')).result).toMatchObject({
      outcome: 'confirmed',
      kind: 'fee_collector',
      // The FeeCollector called Uniswap SwapRouter02 on Base: the row's "kyberswap" is replaced.
      derived: { tokenIn: BASE_WETH, amountIn: '250000000000000000', tokenOut: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf', amountOut: '16442786763241155389', source: 'uniswapv3' },
    })
  })

  it('Arbitrum: token to ETH', async () => {
    const f = R.arbitrumFcTokenToEth
    expect((await verify(f, sender(f), 'kyberswap')).result).toMatchObject({
      outcome: 'confirmed',
      kind: 'fee_collector',
      derived: { tokenIn: ARB_USDC, amountIn: '2624161', tokenOut: NATIVE_PLACEHOLDER, amountOut: '1380699133234074', source: 'kyberswap' },
    })
  })

  it('A.3 wrong sender: another wallet can not claim a FeeCollector swap (one read, no receipt read)', async () => {
    for (const f of [R.mainnetFcTokenToToken, R.baseFcEthToToken, R.arbitrumFcTokenToEth]) {
      const { result, calls } = await verify(f, OTHER_WALLET, 'velora')
      expect(result).toEqual({ outcome: 'rejected', reason: 'wrong_sender' })
      expect(calls.map((c) => c.method)).toEqual(['eth_getTransactionByHash'])
    }
  })

  it('the wallet is compared case-insensitively', async () => {
    const f = R.mainnetFcTokenToToken
    expect((await verify(f, `0x${sender(f).slice(2).toUpperCase()}`, 'velora')).result.outcome).toBe('confirmed')
    expect((await verify(f, sender(f).toLowerCase(), 'velora')).result.outcome).toBe('confirmed')
  })

  it('a SwapWithFee event of ANOTHER user in this wallet\'s transaction is not this wallet\'s swap: nothing is taken from it', async () => {
    // On-chain the event's user is always the caller, so this receipt can not exist; the function still must not read
    // a side out of an event that names someone else.
    const f = R.mainnetFcTokenToEth
    const collector = FIXTURE_FEE_COLLECTOR[1].toLowerCase()
    const other = structuredClone(f.receipt)
    let changed = 0
    for (const log of other.logs) {
      const topics = log.topics as string[]
      if (String(log.address).toLowerCase() === collector && topics.length === 3) {
        topics[1] = `0x${'0'.repeat(24)}${OTHER_WALLET.slice(2)}`
        changed++
      }
    }
    expect(changed).toBe(1)
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: other })
    const result = await verifySwapOnChain(input(f, sender(f), 'velora'), { read: chain.read })
    expect(result).toMatchObject({ outcome: 'confirmed', kind: 'fee_collector', derived: { tokenIn: null, amountIn: null, tokenOut: null, amountOut: null } })
  })

  it('a SwapWithFee event counts only when the FeeCollector itself emitted it, for this wallet', async () => {
    const f = R.mainnetFcTokenToEth
    const collector = FIXTURE_FEE_COLLECTOR[1].toLowerCase()
    const moved = structuredClone(f.receipt)
    for (const log of moved.logs) if (String(log.address).toLowerCase() === collector) log.address = '0x00000000000000000000000000000000000000bb'
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: moved })
    const result = await verifySwapOnChain(input(f, sender(f), 'velora'), { read: chain.read })
    // Still this wallet's transaction to our FeeCollector, so still confirmed, but nothing the forged log says is taken.
    expect(result).toMatchObject({ outcome: 'confirmed', kind: 'fee_collector', derived: { tokenIn: null, amountIn: null, tokenOut: null, amountOut: null } })
  })
})

describe('kind router: tx.to is the router of the row\'s source on the row\'s chain', () => {
  it('Ethereum, 0x, token to token: sides from the wallet\'s ERC-20 Transfer legs', async () => {
    const f = R.mainnetRouterTokenToToken
    const { result, calls } = await verify(f, sender(f), '0x')
    expect(result).toMatchObject({
      outcome: 'confirmed',
      kind: 'router',
      derived: { tokenIn: USDC, amountIn: '101939506', tokenOut: USDT, amountOut: '102059274', source: '0x' },
    })
    expect(calls).toHaveLength(2)
  })

  it('Ethereum, 0x, reverted: failed, both sides null', async () => {
    const f = R.mainnetRouterReverted
    const { result } = await verify(f, sender(f), '0x')
    expect(result).toMatchObject({ outcome: 'failed', kind: 'router', derived: { tokenIn: null, amountIn: null, tokenOut: null, amountOut: null, source: '0x' } })
  })

  it('A.6 two candidates on one side (ETH paid AND a token sent): that side is null, never a guess', async () => {
    const f = R.mainnetRouterValueAndToken
    expect(BigInt(String(f.tx.value)) > 0n).toBe(true)
    const { result } = await verify(f, sender(f), '0x')
    expect(result.outcome).toBe('confirmed')
    expect(result.kind).toBe('router')
    expect(result.derived).toMatchObject({ tokenIn: null, amountIn: null, tokenOut: null, amountOut: null })
  })

  it('Base, 0x, token to ETH: the ETH that came back left no log, so the bought side is null', async () => {
    const f = R.baseRouterTokenToEth
    const { result } = await verify(f, sender(f), '0x')
    expect(result).toMatchObject({
      outcome: 'confirmed',
      kind: 'router',
      derived: { tokenIn: '0xe43df70a3a8067680aae799fa5171c3f473b46ed', amountIn: '5680910050800089169920', tokenOut: null, amountOut: null, source: '0x' },
    })
  })

  it('Arbitrum, 0x, token to token', async () => {
    const f = R.arbitrumRouterTokenToToken
    expect((await verify(f, sender(f), '0x')).result).toMatchObject({
      outcome: 'confirmed',
      kind: 'router',
      derived: { tokenIn: '0x299142a6370e1912156e53fbd4f25d7ba49ddcc5', amountIn: '2000000000000000000', tokenOut: ARB_USDC, amountOut: '1278374', source: '0x' },
    })
  })

  it('A.4 wrong target: the same real swap under another source is not that source\'s router', async () => {
    for (const f of [R.mainnetRouterTokenToToken, R.baseRouterTokenToEth, R.arbitrumRouterTokenToToken]) {
      for (const source of ['1inch', 'velora', 'kyberswap', 'uniswap', 'teraswap_order_engine']) {
        const { result, calls } = await verify(f, sender(f), source)
        expect(result).toEqual({ outcome: 'rejected', reason: 'wrong_target' })
        expect(calls).toHaveLength(1)
      }
    }
  })

  it('A.3 wrong sender: another wallet can not claim a router swap', async () => {
    for (const f of [R.mainnetRouterTokenToToken, R.baseRouterTokenToEth, R.arbitrumRouterTokenToToken]) {
      expect((await verify(f, OTHER_WALLET, '0x')).result).toEqual({ outcome: 'rejected', reason: 'wrong_sender' })
    }
  })

  it('a transfer leg is an ERC-20 Transfer of the wallet: another wallet\'s legs, zero values and NFT transfers are not', async () => {
    const f = R.mainnetRouterTokenToToken
    const wallet = sender(f).toLowerCase()
    const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`
    const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`
    const extra = [
      // A third party's transfer of yet another token: not the wallet's.
      { address: DAI, topics: [transfer, pad(OTHER_WALLET), pad('0x00000000000000000000000000000000000000cc')], data: word(5n) },
      // A zero-value transfer TO the wallet (the address-poisoning shape): not a leg.
      { address: DAI, topics: [transfer, pad(OTHER_WALLET), pad(wallet)], data: word(0n) },
      // An ERC-721 Transfer to the wallet: four topics, no amount.
      { address: '0x00000000000000000000000000000000000000dd', topics: [transfer, pad(OTHER_WALLET), pad(wallet), word(7n)], data: '0x' },
      // A transfer from the wallet to itself.
      { address: WETH, topics: [transfer, pad(wallet), pad(wallet)], data: word(9n) },
    ]
    const receipt = structuredClone(f.receipt)
    receipt.logs.push(...extra)
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: receipt })
    const result = await verifySwapOnChain(input(f, sender(f), '0x'), { read: chain.read })
    expect(result.derived).toMatchObject({ tokenIn: USDC, amountIn: '101939506', tokenOut: USDT, amountOut: '102059274' })

    // A real second incoming token does make two candidates: the bought side becomes null.
    const two = structuredClone(f.receipt)
    two.logs.push({ address: DAI, topics: [transfer, pad(OTHER_WALLET), pad(wallet)], data: word(1n) })
    const again = await verifySwapOnChain(input(f, sender(f), '0x'), { read: recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: two }).read })
    expect(again.derived).toMatchObject({ tokenIn: USDC, amountIn: '101939506', tokenOut: null, amountOut: null })
  })
})

describe('kind cow: a Trade event emitted by that chain\'s settlement contract whose owner is the wallet', () => {
  it('Ethereum, sent to the settlement contract: sides from the Trade event', async () => {
    const f = R.mainnetCowDirect
    const owner = '0x7249c6f7434dd3D884a2E1eb19b57076D5aF6F67'
    expect(String(f.tx.to).toLowerCase()).toBe(cowSettlementOf(1))
    const { result, calls } = await verify(f, owner, 'cowswap')
    expect(result).toMatchObject({
      outcome: 'confirmed',
      kind: 'cow',
      derived: { tokenIn: USDC, amountIn: '649256721', tokenOut: USDT, amountOut: '650044918', source: 'cowswap' },
    })
    expect(calls).toHaveLength(2)
  })

  it('the solver sends the transaction: tx.from is not the wallet and that is not a reason to reject', async () => {
    const f = R.mainnetCowDirect
    expect(sender(f).toLowerCase()).not.toBe('0x7249c6f7434dd3d884a2e1eb19b57076d5af6f67')
    expect((await verify(f, '0x7249c6f7434dd3D884a2E1eb19b57076D5aF6F67', 'cowswap')).result.outcome).toBe('confirmed')
  })

  it('Ethereum and Arbitrum, sent to a SOLVER\'S contract: the settlement contract\'s Trade event still proves it (owner 2026-11-25)', async () => {
    const m = R.mainnetCowViaSolver
    expect(String(m.tx.to).toLowerCase()).not.toBe(cowSettlementOf(1))
    expect((await verify(m, '0x2A426b6b4589A3A44a053Da440C45fF41e16f52C', 'cowswap')).result).toMatchObject({
      outcome: 'confirmed',
      kind: 'cow',
      derived: { tokenIn: DAI, amountIn: '25061937000000000098304', tokenOut: USDC, amountOut: '25062027165', source: 'cowswap' },
    })
    const a = R.arbitrumCowViaSolver
    expect(String(a.tx.to).toLowerCase()).not.toBe(cowSettlementOf(42161))
    expect((await verify(a, '0x36254BCAF6D76Bbd5493C3B5D99Dc8fb6D886dAF', 'cowswap')).result).toMatchObject({
      outcome: 'confirmed',
      kind: 'cow',
      derived: { tokenIn: ARB_WETH, amountIn: '5000000000000000', tokenOut: ARB_USDC, amountOut: '8235646', source: 'cowswap' },
    })
  })

  it('Base, sent to the settlement contract', async () => {
    const f = R.baseCowDirect
    expect((await verify(f, '0x256534D1B3042a4906696E27868c7b4905628921', 'cowswap')).result).toMatchObject({
      outcome: 'confirmed',
      kind: 'cow',
      derived: { tokenIn: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf', amountIn: '714285714285714285', tokenOut: BASE_USDC, amountOut: '17584904', source: 'cowswap' },
    })
  })

  it('the CoW trade of another owner: a wallet with no Trade in that settlement is rejected', async () => {
    for (const f of [R.mainnetCowDirect, R.mainnetCowViaSolver, R.baseCowDirect, R.arbitrumCowViaSolver]) {
      expect((await verify(f, OTHER_WALLET, 'cowswap')).result).toEqual({ outcome: 'rejected', reason: 'cow_no_trade_for_wallet' })
      // Not the solver either, although it sent the transaction.
      expect((await verify(f, sender(f), 'cowswap')).result).toEqual({ outcome: 'rejected', reason: 'cow_no_trade_for_wallet' })
    }
  })

  it('one settlement, two wallets: each gets its own trade and never the other\'s', async () => {
    const f = R.mainnetCowTwoOwners
    expect((await verify(f, '0x0E269d0c3941077Dee8e7BE50899e3B10eaE35B6', 'cowswap')).result.derived).toMatchObject({
      tokenIn: WETH, amountIn: '2500000000000000000', tokenOut: USDT, amountOut: '4135423743',
    })
    expect((await verify(f, '0xb5378cf59F35E6e8bf5679ec6C22D1C5Ff912433', 'cowswap')).result.derived).toMatchObject({
      tokenIn: USDT, amountIn: '4136496015', tokenOut: WETH, amountOut: '2499982040053135866',
    })
  })

  it('only a cowswap row can be kind cow: the same settlement under another source is the wrong target (one read)', async () => {
    const f = R.mainnetCowDirect
    for (const source of ['1inch', '0x', 'velora', 'uniswapv3']) {
      const { result, calls } = await verify(f, '0x7249c6f7434dd3D884a2E1eb19b57076D5aF6F67', source)
      expect(result).toEqual({ outcome: 'rejected', reason: 'wrong_target' })
      expect(calls).toHaveLength(1)
    }
  })

  it('a Trade event counts only when the settlement contract itself emitted it', async () => {
    const f = R.mainnetCowDirect
    const settlement = cowSettlementOf(1) as string
    const forged = structuredClone(f.receipt)
    for (const log of forged.logs) if (String(log.address).toLowerCase() === settlement) log.address = '0x00000000000000000000000000000000000000bb'
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: forged })
    const result = await verifySwapOnChain(input(f, '0x7249c6f7434dd3D884a2E1eb19b57076D5aF6F67', 'cowswap'), { read: chain.read })
    expect(result).toEqual({ outcome: 'rejected', reason: 'cow_no_trade_for_wallet' })
  })

  it('a cowswap row whose transaction is an ordinary transfer or another protocol\'s swap is rejected after its receipt', async () => {
    // A real 0x swap registered as a CoW swap by its own sender: no Trade event of the settlement contract in it.
    const f = R.mainnetRouterTokenToToken
    const { result, calls } = await verify(f, sender(f), 'cowswap')
    expect(result).toEqual({ outcome: 'rejected', reason: 'cow_no_trade_for_wallet' })
    expect(calls).toHaveLength(2)
  })

  it('two trades of one wallet in one settlement: a side is derived only when both name the same token', async () => {
    const f = R.mainnetCowDirect
    const settlement = cowSettlementOf(1) as string
    const tradeLog = f.receipt.logs.find((l) => String(l.address).toLowerCase() === settlement && String((l.topics as string[])[0]) === '0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17')
    expect(tradeLog).toBeDefined()
    const same = structuredClone(f.receipt)
    same.logs.push(structuredClone(tradeLog as Record<string, unknown>))
    const twice = await verifySwapOnChain(input(f, '0x7249c6f7434dd3D884a2E1eb19b57076D5aF6F67', 'cowswap'), {
      read: recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: same }).read,
    })
    expect(twice.derived).toMatchObject({ tokenIn: USDC, amountIn: String(649256721n * 2n), tokenOut: USDT, amountOut: String(650044918n * 2n) })
  })
})

describe('chain-aware: the row\'s chain decides the FeeCollector, the routers and the settlement contract', () => {
  it('a transaction exists only on its own chain: the right hash on the wrong chain is not found', async () => {
    const f = R.mainnetFcTokenToToken
    for (const chainId of [8453, 42161]) {
      const { result, calls } = await verify(f, sender(f), 'velora', chainId)
      expect(result).toEqual({ outcome: 'not_found', reason: 'tx_missing' })
      expect(calls).toEqual([{ chainId, method: 'eth_getTransactionByHash', hash: f.hash.toLowerCase() }])
    }
  })

  it('the same address is another contract on another chain: 0x47f2…7459 is the FeeCollector on Ethereum only', async () => {
    // docs/DEPLOYMENTS.md: 0x47f2…7459 is the FeeCollector V2 on Ethereum and the OrderExecutor V3 on Arbitrum;
    // 0xeFC3…f130 is the FeeCollector on Base and Arbitrum and the OrderExecutor on Ethereum. A node that served the
    // Ethereum transaction for an Arbitrum row (or the Base one for an Ethereum row) must not make it a FeeCollector swap.
    const eth = R.mainnetFcTokenToToken
    const asArbitrum = { ...eth, chainId: 42161 }
    const a = await verifySwapOnChain(input(asArbitrum, sender(eth), 'velora'), { read: recordedChainRead([asArbitrum]).read })
    expect(a).toEqual({ outcome: 'rejected', reason: 'wrong_target' })

    const base = R.baseFcEthToToken
    const asEthereum = { ...base, chainId: 1 }
    const b = await verifySwapOnChain(input(asEthereum, sender(base), 'velora'), { read: recordedChainRead([asEthereum]).read })
    expect(b).toEqual({ outcome: 'rejected', reason: 'wrong_target' })
  })

  it('a router is looked up on the row\'s chain: Uniswap\'s Base router is not a router on Ethereum', async () => {
    expect(routerOf(8453, 'uniswapv3')).toBe('0x2626664c2603336e57b271c5c0b26f421741e481')
    expect(routerOf(1, 'uniswapv3')).toBe('0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45')
    expect(sourceOfRouter(1, '0x2626664c2603336E57B271c5C0b26F421741e481')).toBe('unknown')
    expect(sourceOfRouter(8453, '0x2626664c2603336E57B271c5C0b26F421741e481')).toBe('uniswapv3')
  })
})

describe('a chain with no FeeCollector configured has no kind fee_collector (fail closed)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('Base without NEXT_PUBLIC_BASE_FEE_COLLECTOR: the real Base FeeCollector swap is the wrong target', async () => {
    const saved = process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR
    delete process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR
    try {
      const fresh = await import('./verify-swap-on-chain')
      expect(fresh.feeCollectorsOf(8453)).toEqual({ current: null, v1: null })
      const f = R.baseFcEthToToken
      const result = await fresh.verifySwapOnChain(input(f, sender(f), 'velora'), { read: recordedChainRead().read })
      expect(result).toEqual({ outcome: 'rejected', reason: 'wrong_target' })
    } finally {
      process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = saved
    }
  })
})

describe('A.2 and fail closed: a missing answer, an error or an unknown shape never confirms', () => {
  const f = R.mainnetFcTokenToToken
  const good = () => input(f, sender(f), 'velora')

  it('missing transaction: not_found after one read', async () => {
    const chain = recordedChainRead([])
    expect(await verifySwapOnChain(good(), { read: chain.read })).toEqual({ outcome: 'not_found', reason: 'tx_missing' })
    expect(chain.calls).toHaveLength(1)
  })

  it('missing receipt (the transaction is still pending): not_found', async () => {
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: null })
    expect(await verifySwapOnChain(good(), { read: chain.read })).toEqual({ outcome: 'not_found', reason: 'receipt_missing' })
    expect(chain.calls).toHaveLength(2)
  })

  it.each(['rpc_error', 'rpc_wrong_chain', 'rpc_unverified'] as const)('the chain read fails with %s on either read: not_found with that reason', async (code) => {
    for (const method of ['eth_getTransactionByHash', 'eth_getTransactionReceipt'] as const) {
      const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { [method]: new ChainReadError(code) })
      expect(await verifySwapOnChain(good(), { read: chain.read })).toEqual({ outcome: 'not_found', reason: code })
    }
  })

  it('any other error from the read (a timeout, a bug) is not_found/rpc_error and carries no text of it', async () => {
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionByHash: new Error('https://provider.example/v2/SECRET-KEY timed out') })
    const result = await verifySwapOnChain(good(), { read: chain.read })
    expect(result).toEqual({ outcome: 'not_found', reason: 'rpc_error' })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  const txChanges: Array<[string, (tx: Record<string, unknown>) => unknown]> = [
    ['not an object', () => 'ok'],
    ['an array', () => []],
    ['no from', (tx) => ({ ...tx, from: undefined })],
    ['from is not an address', (tx) => ({ ...tx, from: '0x1234' })],
    ['to is not an address', (tx) => ({ ...tx, to: 'confirmed' })],
    ['no value', (tx) => ({ ...tx, value: undefined })],
    ['value is a number', (tx) => ({ ...tx, value: 5 })],
    ['no input', (tx) => ({ ...tx, input: undefined })],
    ['the hash of another transaction', (tx) => ({ ...tx, hash: `0x${'ab'.repeat(32)}` })],
  ]
  it.each(txChanges)('a transaction answer with %s: not_found/rpc_malformed', async (_name, change) => {
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionByHash: change(structuredClone(f.tx)) })
    expect(await verifySwapOnChain(good(), { read: chain.read })).toEqual({ outcome: 'not_found', reason: 'rpc_malformed' })
  })

  const receiptChanges: Array<[string, (r: SwapReceiptFixture['receipt']) => unknown]> = [
    ['not an object', () => 1],
    ['status 0x2', (r) => ({ ...r, status: '0x2' })],
    ['status "success" as a word', (r) => ({ ...r, status: 'success' })],
    ['status true', (r) => ({ ...r, status: true })],
    ['no status', (r) => ({ ...r, status: undefined })],
    ['logs that are not a list', (r) => ({ ...r, logs: {} })],
    ['a log with a bad address', (r) => ({ ...r, logs: [{ ...r.logs[0], address: 'x' }, ...r.logs.slice(1)] })],
    ['a log with a bad topic', (r) => ({ ...r, logs: [{ ...r.logs[0], topics: ['0x12'] }, ...r.logs.slice(1)] })],
    ['a log whose data is not hex', (r) => ({ ...r, logs: [{ ...r.logs[0], data: 'zz' }, ...r.logs.slice(1)] })],
    ['the hash of another transaction', (r) => ({ ...r, transactionHash: `0x${'ab'.repeat(32)}` })],
    ['another sender than the transaction', (r) => ({ ...r, from: OTHER_WALLET })],
    ['another target than the transaction', (r) => ({ ...r, to: OTHER_WALLET })],
    ['status reverted but logs present', (r) => ({ ...r, status: '0x0' })],
  ]
  it.each(receiptChanges)('a receipt answer with %s: not_found/rpc_malformed', async (_name, change) => {
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: change(structuredClone(f.receipt)) })
    expect(await verifySwapOnChain(good(), { read: chain.read })).toEqual({ outcome: 'not_found', reason: 'rpc_malformed' })
  })

  it('a contract creation (tx.to null) is the wrong target', async () => {
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionByHash: { ...structuredClone(f.tx), to: null } })
    expect(await verifySwapOnChain(good(), { read: chain.read })).toEqual({ outcome: 'rejected', reason: 'wrong_target' })
  })

  it('A.5: the receipt status, and nothing else, decides confirmed or failed', async () => {
    // The same real successful transaction with its status flipped and its logs dropped (what a revert looks like).
    const reverted = { ...structuredClone(f.receipt), status: '0x0', logs: [] }
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: reverted })
    const result = await verifySwapOnChain(good(), { read: chain.read })
    expect(result.outcome).toBe('failed')
    expect(result.derived).toMatchObject({ tokenIn: null, amountIn: null, tokenOut: null, amountOut: null })
  })

  it('a receipt with no gas fields still verifies; gas is null, not a guess', async () => {
    const chain = recordedChainRead(ALL_SWAP_RECEIPTS, { eth_getTransactionReceipt: { ...structuredClone(f.receipt), gasUsed: undefined, effectiveGasPrice: undefined } })
    const result = await verifySwapOnChain(good(), { read: chain.read })
    expect(result.outcome).toBe('confirmed')
    expect(result.derived).toMatchObject({ gasUsed: null, gasPrice: null })
  })
})

describe('every real fixture, checked against every wallet that is not in it', () => {
  it('no fixture verifies for a stranger under any source', async () => {
    const sources = ['1inch', '0x', 'velora', 'kyberswap', 'cowswap', 'uniswapv3', 'sushiswap', 'curve', 'openocean', 'odos', 'balancer', 'bebop', 'uniswap', 'teraswap_order_engine']
    for (const f of ALL_SWAP_RECEIPTS) {
      for (const source of sources) {
        const { result } = await verify(f, OTHER_WALLET, source)
        expect(result.outcome, `${f.name} as ${source}`).toBe('rejected')
      }
    }
  })
})

void DAI
