/**
 * [FEAT-DCA-FLOOR-TIERS] classifyDcaFloor — the three tiers, fail-closed lookup, chain awareness,
 * native→wrapped resolution, and the pin between the UI/server cap and the keeper's cap.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BASE_V3 = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'
const ARB_V3 = '0x2222222222222222222222222222222222222222'
vi.mock('./config', async () => {
  const actual = await vi.importActual<typeof import('./config')>('./config')
  return { ...actual, getOrderExecutorV3: (id: number) => (id === 8453 ? BASE_V3 : id === 42161 ? ARB_V3 : null) }
})
vi.mock('@/lib/chains/clients', () => ({ getPublicClientForChain: () => { throw new Error('tests inject a reader') } }))
vi.mock('@/lib/defillama', () => ({ fetchDefiLlamaPrice: vi.fn() }))

import { classifyDcaFloor, classifyDcaFloorDetailed, DCA_NO_PRICE_FILL_CAP_USD } from './dca-floor-tier'

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ETHFI = '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB'
const REG = ['0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 8, 18, 3600n, true] as const
const ZERO = ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false] as const

function reader(registered: string[], opts: { throws?: boolean } = {}) {
  const calls: Array<{ address: string; token: string }> = []
  return {
    calls,
    readContract: async ({ address, args }: { address: string; args: readonly unknown[] }) => {
      calls.push({ address, token: String(args[0]).toLowerCase() })
      if (opts.throws) throw new Error('rpc down')
      return registered.map(a => a.toLowerCase()).includes(String(args[0]).toLowerCase()) ? REG : ZERO
    },
  }
}
const priced = (addrs: string[]) => async (a: string) => (addrs.map(x => x.toLowerCase()).includes(a.toLowerCase()) ? 1 : null)

describe('classifyDcaFloor', () => {
  it('onchain-feed: both legs registered in the executor', async () => {
    const r = reader([WETH_BASE, USDC_BASE])
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: r, priceUsd: priced([]) })).toBe('onchain-feed')
  })

  it('offchain-price: not both registered, but every non-WETH leg has an off-chain price', async () => {
    const r = reader([WETH_BASE])
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: ETHFI }, { reader: r, priceUsd: priced([ETHFI]) })).toBe('offchain-price')
  })

  it('unpriced: a leg with neither a registered feed nor an off-chain price', async () => {
    const r = reader([WETH_BASE])
    const out = await classifyDcaFloorDetailed({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: ETHFI }, { reader: r, priceUsd: priced([]) })
    expect(out).toEqual({ tier: 'unpriced', affected: [ETHFI] })
  })

  it('registry lookup failure ⇒ unpriced (never a weaker tier), even when prices exist', async () => {
    const r = reader([], { throws: true })
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: r, priceUsd: priced([USDC_BASE]) })).toBe('unpriced')
  })

  it('price-source failure ⇒ unpriced', async () => {
    const r = reader([WETH_BASE])
    const boom = async () => { throw new Error('llama down') }
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: ETHFI }, { reader: r, priceUsd: boom })).toBe('unpriced')
  })

  it('no executor configured / unsupported chain ⇒ unpriced', async () => {
    expect(await classifyDcaFloor({ chainId: 1, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: reader([]), priceUsd: priced([WETH_BASE, USDC_BASE]) })).toBe('unpriced')
    expect(await classifyDcaFloor({ chainId: 999999, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: reader([]) })).toBe('unpriced')
  })

  it('is chain-aware: the registry is read on EACH chain\'s own V3 executor', async () => {
    const base = reader([])
    await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: base, priceUsd: priced([]) })
    expect(new Set(base.calls.map(c => c.address))).toEqual(new Set([BASE_V3]))
    const arb = reader([])
    await classifyDcaFloor({ chainId: 42161, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: arb, priceUsd: priced([]) })
    expect(new Set(arb.calls.map(c => c.address))).toEqual(new Set([ARB_V3]))
  })

  it('native ETH resolves to that chain\'s WETH (registry asked about WETH, never the sentinel)', async () => {
    const r = reader([WETH_BASE, USDC_BASE])
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: NATIVE, tokenOut: USDC_BASE }, { reader: r, priceUsd: priced([]) })).toBe('onchain-feed')
    expect(r.calls.map(c => c.token)).toContain(WETH_BASE.toLowerCase())
    expect(r.calls.map(c => c.token)).not.toContain(NATIVE.toLowerCase())
  })

  it('WETH needs no DefiLlama price (Chainlink prices it): WETH unregistered ⇒ offchain-price, and WETH itself is never looked up', async () => {
    const r = reader([USDC_BASE])
    const lookups: string[] = []
    const priceUsd = async (a: string) => { lookups.push(a); return 1 }
    expect(await classifyDcaFloor({ chainId: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE }, { reader: r, priceUsd })).toBe('offchain-price')
    expect(lookups).toEqual([USDC_BASE]) // only the non-WETH leg is looked up
  })
})

describe('DCA_NO_PRICE_FILL_CAP_USD', () => {
  it('equals the keeper\'s DCA_FAIL_OPEN_MAX_USD (order-floor.js:188) — imported value AND source text', async () => {
    const path = resolve(__dirname, '../../../contracts/order-engine/executor/order-floor.js')
    const keeper = await import(/* @vite-ignore */ pathToFileURL(path).href)
    expect(DCA_NO_PRICE_FILL_CAP_USD).toBe(keeper.DCA_FAIL_OPEN_MAX_USD)
    const m = readFileSync(path, 'utf8').match(/export const DCA_FAIL_OPEN_MAX_USD\s*=\s*(\d[\d_]*)/)
    expect(Number(m?.[1].replace(/_/g, ''))).toBe(DCA_NO_PRICE_FILL_CAP_USD)
  })
})
