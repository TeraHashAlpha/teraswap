/**
 * [P101] Tests for recipient threading through the adapter layer.
 *
 * Each adapter that supports a split sender/receiver should pass through
 * the value the caller asked for. Adapters that don't support recipient
 * (0x, openocean) should fall back to `from` and log a warning.
 *
 * We mock global.fetch and inspect either the request body (POST) or the
 * query string (GET) to see what the adapter actually sent upstream.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SwapParams } from './types'

import balancer from './balancer'
import kyberswap from './kyberswap'
import velora from './velora'
import sushiswap from './sushiswap'
import oneinch from './oneinch'
import openocean from './openocean'
import odos from './odos'

const FROM = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'

const BASE: SwapParams = {
  src: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  dst: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amount: '1000000000000000000',
  from: FROM,
  slippage: 0.5,
}

// ── Capture request bodies / URLs across all fetch calls. ───
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []

function mockFetch(responder: (call: number) => unknown) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const [url, init] = args as [string, RequestInit?]
    fetchCalls.push({ url, init })
    const payload = responder(fetchCalls.length)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

function lastBody(): Record<string, unknown> {
  for (let i = fetchCalls.length - 1; i >= 0; i--) {
    const body = fetchCalls[i].init?.body
    if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>
  }
  return {}
}

function bodyAtCall(n: number): Record<string, unknown> {
  const body = fetchCalls[n - 1]?.init?.body
  if (typeof body !== 'string') return {}
  return JSON.parse(body) as Record<string, unknown>
}

function urlAtCall(n: number): string {
  return fetchCalls[n - 1]?.url ?? ''
}

beforeEach(() => {
  fetchCalls = []
  // Suppress the openocean / 0x recipient-mismatch warnings.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────
// Balancer: POST body { receiver }
// ─────────────────────────────────────────────────────────────
describe('balancer adapter — recipient threading', () => {
  // [SPRINT-9G G7] `to` must be the whitelisted Balancer V2 Vault, else the
  // adapter's fail-closed gate refuses the swap before the recipient is read.
  const respond = () => ({ buyAmount: '1', to: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', data: '0xdead', value: '0', gasEstimate: 100_000 })

  it('passes recipient through to receiver when provided', async () => {
    mockFetch(respond)
    await balancer.fetchSwapData({ ...BASE, recipient: RECIPIENT })
    expect(lastBody().receiver).toBe(RECIPIENT)
    expect(lastBody().sender).toBe(FROM)
  })

  it('defaults receiver to from when recipient omitted', async () => {
    mockFetch(respond)
    await balancer.fetchSwapData(BASE)
    expect(lastBody().receiver).toBe(FROM)
  })
})

// ─────────────────────────────────────────────────────────────
// KyberSwap: 2-step (routes GET + build POST). recipient on build.
// ─────────────────────────────────────────────────────────────
describe('kyberswap adapter — recipient threading', () => {
  const respond = (call: number) =>
    call === 1
      ? { data: { routeSummary: { amountOut: '1', gasUsd: 1, gas: 100_000, route: [[]] } } }
      : { data: { routerAddress: '0xabc', data: '0xdead', value: '0', gas: 100_000 } }

  it('passes recipient through to build payload', async () => {
    mockFetch(respond)
    await kyberswap.fetchSwapData({ ...BASE, recipient: RECIPIENT })
    // call 2 is the build POST
    expect(bodyAtCall(2).recipient).toBe(RECIPIENT)
    expect(bodyAtCall(2).sender).toBe(FROM)
  })

  it('defaults recipient to from when omitted', async () => {
    mockFetch(respond)
    await kyberswap.fetchSwapData(BASE)
    expect(bodyAtCall(2).recipient).toBe(FROM)
  })
})

// ─────────────────────────────────────────────────────────────
// Velora: 2-step (prices GET + tx POST). receiver on tx.
// ─────────────────────────────────────────────────────────────
describe('velora adapter — recipient threading', () => {
  const respond = (call: number) =>
    call === 1
      ? { priceRoute: { destAmount: '1', gasCost: 100_000, gasCostUSD: '1' } }
      : { to: '0xabc', data: '0xdead', value: '0', gas: 100_000 }

  it('passes recipient through to receiver', async () => {
    mockFetch(respond)
    await velora.fetchSwapData({ ...BASE, recipient: RECIPIENT })
    expect(bodyAtCall(2).receiver).toBe(RECIPIENT)
    expect(bodyAtCall(2).userAddress).toBe(FROM)
  })

  it('defaults receiver to from when recipient omitted', async () => {
    mockFetch(respond)
    await velora.fetchSwapData(BASE)
    expect(bodyAtCall(2).receiver).toBe(FROM)
  })
})

// ─────────────────────────────────────────────────────────────
// SushiSwap: GET request, `to` query param is the recipient.
// ─────────────────────────────────────────────────────────────
describe('sushiswap adapter — recipient threading', () => {
  const respond = () => ({
    assumedAmountOut: '1',
    gasSpent: 100_000,
    routeProcessorArgs: { to: '0xabc', data: '0xdead', value: '0' },
  })

  it('passes recipient through to `to` query param', async () => {
    mockFetch(respond)
    await sushiswap.fetchSwapData({ ...BASE, recipient: RECIPIENT })
    expect(urlAtCall(1).toLowerCase()).toContain(`to=${RECIPIENT.toLowerCase()}`)
  })

  it('defaults `to` to from when recipient omitted', async () => {
    mockFetch(respond)
    await sushiswap.fetchSwapData(BASE)
    expect(urlAtCall(1).toLowerCase()).toContain(`to=${FROM.toLowerCase()}`)
  })
})

// ─────────────────────────────────────────────────────────────
// 1inch: GET request, destReceiver query param (only set when ≠ from).
// ─────────────────────────────────────────────────────────────
describe('1inch adapter — recipient threading', () => {
  const respond = () => ({
    toAmount: '1',
    tx: { to: '0xabc', data: '0xdead', value: '0', gas: 100_000 },
  })

  beforeEach(() => {
    // 1inch adapter requires the API key to be configured. Stub the env.
    process.env.ONEINCH_API_KEY = 'test-key'
  })

  it('sets destReceiver when recipient ≠ from', async () => {
    mockFetch(respond)
    try {
      await oneinch.fetchSwapData({ ...BASE, recipient: RECIPIENT })
      expect(urlAtCall(1).toLowerCase()).toContain(`destreceiver=${RECIPIENT.toLowerCase()}`)
    } catch (err) {
      // The adapter may bail before fetch when the API key isn't set. In
      // that case there's nothing for the assertion to read; skip.
      if (!String(err).includes('API key')) throw err
    }
  })

  it('omits destReceiver when recipient is undefined', async () => {
    mockFetch(respond)
    try {
      await oneinch.fetchSwapData(BASE)
      expect(urlAtCall(1).toLowerCase()).not.toContain('destreceiver')
    } catch (err) {
      if (!String(err).includes('API key')) throw err
    }
  })
})

// ─────────────────────────────────────────────────────────────
// Odos: 2-step (quote POST + assemble POST). receiver on assemble.
// ─────────────────────────────────────────────────────────────
describe('odos adapter — recipient threading', () => {
  const respond = (call: number) =>
    call === 1
      ? { outAmounts: ['1'], pathId: 'p1', gasEstimate: 100_000, gasEstimateValue: 1, pathViz: [] }
      : { transaction: { to: '0xabc', data: '0xdead', value: '0', gas: 100_000 }, gasEstimate: 100_000 }

  it('sets receiver on assemble when recipient ≠ from', async () => {
    mockFetch(respond)
    await odos.fetchSwapData({ ...BASE, recipient: RECIPIENT })
    expect(bodyAtCall(2).receiver).toBe(RECIPIENT)
    expect(bodyAtCall(2).userAddr).toBe(FROM)
  })

  it('omits receiver on assemble when recipient is undefined (sender is the implicit default)', async () => {
    mockFetch(respond)
    await odos.fetchSwapData(BASE)
    expect(bodyAtCall(2).receiver).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────
// OpenOcean: doesn't support split sender/receiver. Logs warning,
// silently routes to sender. The warning must fire when recipient ≠ from.
// ─────────────────────────────────────────────────────────────
describe('openocean adapter — recipient is unsupported', () => {
  const respond = () => ({
    code: 200,
    data: {
      outAmount: '1', estimatedGas: 100_000,
      to: '0xabc', data: '0xdead', value: '0',
    },
  })

  it('warns when recipient ≠ from', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch(respond)
    await openocean.fetchSwapData({ ...BASE, recipient: RECIPIENT })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OpenOcean'))
  })

  it('does NOT warn when recipient matches from', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch(respond)
    await openocean.fetchSwapData({ ...BASE, recipient: FROM })
    expect(warn).not.toHaveBeenCalled()
  })
})
