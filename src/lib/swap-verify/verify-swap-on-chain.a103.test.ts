// @vitest-environment node
/**
 * [goal 133b details M] Audit A103, on verifySwapOnChain itself: S-1 (net flows), S-2 (the FeeCollector's own event),
 * S-5 (smart-contract wallets), S-8 (a Base router), and a seeded property over random Transfer-leg sets: a confirmed
 * router swap's in amount never exceeds the wallet's net outflow of that token (and its out amount its net inflow).
 *
 * Every input also carries the round-1 `source` (the audited head required it), so this file runs unchanged on
 * 09ddf974 for the failing-first proof; the function of this branch ignores it (the chain names the source).
 */
import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
})

import { FORK_RECEIPTS as F, SWAP_RECEIPTS as R, recordedChainRead, type SwapReceiptFixture } from '@/lib/__fixtures__/swap-receipts'
import { verifySwapOnChain, type VerifySwapInput, type VerifySwapResult } from './verify-swap-on-chain'

const BASE_WETH = '0x4200000000000000000000000000000000000006'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const sender = (f: SwapReceiptFixture) => String(f.tx.from).toLowerCase()

/** The input, with the round-1 `source` beside it (ignored here; required by the audited head). */
function input(f: SwapReceiptFixture, wallet: string, source: string): VerifySwapInput {
  return Object.assign({ chainId: f.chainId, txHash: f.hash, wallet }, { source }) as VerifySwapInput
}

async function verify(f: SwapReceiptFixture, wallet: string, source: string, overrides: Parameters<typeof recordedChainRead>[1] = {}): Promise<VerifySwapResult> {
  return verifySwapOnChain(input(f, wallet, source), { read: recordedChainRead(undefined, overrides).read })
}

describe('S-1: sides are NET flows', () => {
  it.each([
    ['1', F.pullSweep1],
    ['2', F.pullSweep2],
    ['50', F.pullSweep50],
  ])('%s x [pull(WETH, 1e18), sweepToken(WETH, 1e18, wallet)]: the WETH nets to zero, no in side: rejected', async (_n, f) => {
    // The receipt really holds the round trips: 2 Transfer logs per loop, out of and back into the wallet.
    expect(f.receipt.logs).toHaveLength(2 * Number(_n))
    expect(await verify(f, sender(f), 'uniswapv3')).toEqual({ outcome: 'rejected', reason: 'no_net_swap' })
  })

  it('a real swap through the same router: confirmed, WETH 0.1 for USDC', async () => {
    const f = F.wethToUsdc
    expect(await verify(f, sender(f), 'uniswapv3')).toMatchObject({
      outcome: 'confirmed', kind: 'router', derived: { tokenIn: BASE_WETH, amountIn: '100000000000000000', tokenOut: BASE_USDC, amountOut: '169061391', source: 'uniswapv3' },
    })
  })

  it('a wrap alone and an unwrap alone are what they are (ADR-029 7.6); ETH sent and refunded is rejected (owner, 2026-11-26)', async () => {
    expect(await verify(F.wrapAlone, sender(F.wrapAlone), 'uniswapv3')).toMatchObject({
      outcome: 'confirmed', derived: { tokenIn: NATIVE, amountIn: '500000000000000000', tokenOut: BASE_WETH, amountOut: '500000000000000000' },
    })
    expect(await verify(F.unwrapAlone, sender(F.unwrapAlone), 'uniswapv3')).toMatchObject({
      outcome: 'confirmed', derived: { tokenIn: BASE_WETH, amountIn: '500000000000000000', tokenOut: null, amountOut: null },
    })
    expect(F.ethRefund.receipt.logs).toHaveLength(0)
    expect(await verify(F.ethRefund, sender(F.ethRefund), 'uniswapv3')).toEqual({ outcome: 'rejected', reason: 'no_net_swap' })
  })
})

describe('S-2: proof is the FeeCollector\'s own event, never the target alone', () => {
  it.each([
    ['Ethereum', F.mainnetFcGetter],
    ['Base', F.baseFcGetter],
    ['Arbitrum', F.arbitrumFcGetter],
  ])('%s: TIMELOCK_DELAY() sent as a transaction to the FeeCollector: rejected no_swap_event', async (_chain, f) => {
    expect(f.receipt.logs).toHaveLength(0)
    expect(await verify(f, sender(f), 'kyberswap')).toEqual({ outcome: 'rejected', reason: 'no_swap_event' })
  })

  it('an approve of the FeeCollector, and a FeeCollector call that reverts inside a successful transaction: rejected', async () => {
    expect((await verify(F.approve, sender(F.approve), 'kyberswap')).outcome).toBe('rejected')
    expect((await verify(F.fcRevertsInside, sender(F.fcRevertsInside), 'kyberswap')).outcome).toBe('rejected')
  })

  it('a FeeCollector swap that reverted: failed, never confirmed', async () => {
    expect(await verify(F.fcReverted, sender(F.fcReverted), 'uniswapv3')).toMatchObject({ outcome: 'failed', kind: 'fee_collector', derived: { tokenIn: null, amountIn: null } })
  })

  it('two SwapWithFee events for one wallet in one transaction: ambiguous, rejected', async () => {
    const f = R.mainnetFcTokenToToken
    const collector = '0x47f24068932ac49bcbed3ad105af57c6ecdf7459'
    const event = f.receipt.logs.find((l) => String(l.address).toLowerCase() === collector)
    const twice = structuredClone(f.receipt)
    twice.logs.push(structuredClone(event as Record<string, unknown>))
    expect(await verify(f, sender(f), 'velora', { eth_getTransactionReceipt: twice })).toEqual({ outcome: 'rejected', reason: 'ambiguous' })
  })
})

describe('S-5: a smart-contract wallet is proved by the event, whoever sent the transaction', () => {
  it('Coinbase Smart Wallet, bundler -> EntryPoint -> wallet -> FeeCollector: confirmed for the smart wallet only', async () => {
    const f = F.smartWallet
    const smart = '0x80c4a2bee98d15109e051af1124f2e92d06b7e7b'
    expect(await verify(f, smart, 'uniswapv3')).toMatchObject({
      outcome: 'confirmed', kind: 'fee_collector', derived: { tokenIn: NATIVE, amountIn: '50000000000000000', tokenOut: BASE_USDC, amountOut: '84445542', source: 'uniswapv3' },
    })
    expect((await verify(f, sender(f), 'uniswapv3')).outcome).toBe('rejected')
  })
})

describe('S-8: a router is looked up among THAT chain\'s routers', () => {
  it('Base, USDC sold straight to Uniswap SwapRouter02 (whose address differs from Ethereum\'s): confirmed as uniswapv3', async () => {
    const f = R.baseRouterUniswapTokenToToken
    expect(await verify(f, sender(f), 'uniswapv3')).toMatchObject({
      outcome: 'confirmed', kind: 'router',
      derived: { tokenIn: BASE_USDC, amountIn: '50000000', tokenOut: '0x8185eaf46136a3f095c60facd97eca1bfc2f38f6', amountOut: '15886448751948291128299', source: 'uniswapv3' },
    })
  })
})

// ── Property: random Transfer-leg sets ─────────────────────────────────────────────────────────────────────────────
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`

describe('property, seeded: a confirmed router swap never claims more than the wallet\'s net flows', () => {
  const base = F.wethToUsdc
  const wallet = sender(base)
  const TOKENS = ['0x00000000000000000000000000000000000a0001', '0x00000000000000000000000000000000000a0002', '0x00000000000000000000000000000000000a0003']
  const PARTIES = [wallet, '0x2626664c2603336e57b271c5c0b26f421741e481', '0x00000000000000000000000000000000000b0001', '0x00000000000000000000000000000000000b0002']

  it.each([133, 20261126])('seed %i: 2,000 random receipts', async (seed) => {
    const rand = prng(seed)
    const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)]
    let confirmed = 0
    let roundTrips = 0
    for (let n = 0; n < 2000; n++) {
      const legs: Array<{ token: string; from: string; to: string; value: bigint }> = []
      const count = 1 + Math.floor(rand() * 8)
      for (let i = 0; i < count; i++) {
        const from = pick(PARTIES)
        let to = pick(PARTIES)
        if (to === from) to = PARTIES[(PARTIES.indexOf(from) + 1) % PARTIES.length]
        legs.push({ token: pick(TOKENS), from, to, value: BigInt(1 + Math.floor(rand() * 1_000_000)) })
      }
      const value = rand() < 0.3 ? BigInt(1 + Math.floor(rand() * 1_000_000)) : 0n
      const tx = { ...structuredClone(base.tx), value: `0x${value.toString(16)}` }
      const receipt = { ...structuredClone(base.receipt), logs: legs.map((l, i) => ({ ...structuredClone(base.receipt.logs[0]), address: l.token, topics: [TRANSFER, pad(l.from), pad(l.to)], data: word(l.value), logIndex: `0x${i.toString(16)}` })) }

      const net = new Map<string, bigint>()
      const gross = new Map<string, bigint>()
      for (const l of legs) {
        if (l.from === wallet) {
          net.set(l.token, (net.get(l.token) ?? 0n) - l.value)
          gross.set(l.token, (gross.get(l.token) ?? 0n) + l.value)
        }
        if (l.to === wallet) net.set(l.token, (net.get(l.token) ?? 0n) + l.value)
      }
      if ([...gross].some(([t, g]) => g > -(net.get(t) ?? 0n))) roundTrips++

      const result = await verify(base, wallet, 'uniswapv3', { eth_getTransactionByHash: tx, eth_getTransactionReceipt: receipt })
      if (result.outcome !== 'confirmed') continue
      confirmed++
      const d = result.derived
      const where = `seed ${seed}, case ${n}: ${JSON.stringify({ legs: legs.map((l) => ({ ...l, value: String(l.value) })), value: String(value), derived: d })}`
      expect(d?.tokenIn, where).not.toBeNull()
      if (d?.tokenIn === NATIVE) {
        // The ETH value is the in side only when no token flows out, and only with a token that arrives.
        expect(d.amountIn, where).toBe(value.toString())
        expect([...net.values()].some((v) => v < 0n), where).toBe(false)
        expect(d.tokenOut, where).not.toBeNull()
      } else if (d?.tokenIn) {
        expect(BigInt(d.amountIn ?? '0') <= -(net.get(d.tokenIn) ?? 0n), where).toBe(true)
        expect(BigInt(d.amountIn ?? '0') > 0n, where).toBe(true)
      }
      if (d?.tokenOut && d.tokenOut !== NATIVE) {
        expect(BigInt(d.amountOut ?? '0') <= (net.get(d.tokenOut) ?? 0n), where).toBe(true)
        expect(d.tokenOut, where).not.toBe(d.tokenIn)
      }
    }
    // Not vacuous: many receipts were confirmed, and many had a token that went out and came back.
    expect(confirmed).toBeGreaterThan(300)
    expect(roundTrips).toBeGreaterThan(300)
  }, 60_000)
})
