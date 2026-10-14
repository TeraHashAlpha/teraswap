// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkTokenOnChain, _clearTokenOnChainCache } from './token-on-chain'
import { getChainTokenList } from '@/lib/chains/tokens'
import { NATIVE_ETH } from '@/lib/constants'

const baseTok = getChainTokenList(8453).find(t => t.symbol === 'AERO')!.address
const arbTok = getChainTokenList(42161).find(t => t.symbol === 'ARB')!.address
const UNKNOWN = '0x9999999999999999999999999999999999999999'

beforeEach(() => { _clearTokenOnChainCache(); vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => vi.useRealTimers())

describe('checkTokenOnChain', () => {
  it('native sentinel and known-map addresses pass without any RPC', async () => {
    const getCode = vi.fn()
    expect(await checkTokenOnChain(8453, NATIVE_ETH, { getCode })).toEqual({ onChain: true })
    expect(await checkTokenOnChain(8453, baseTok, { getCode })).toEqual({ onChain: true })
    expect(getCode).not.toHaveBeenCalled()
  })

  it("Arbitrum's ARB on chain 8453 has no code there → onChain:false with a reason", async () => {
    const getCode = vi.fn(async () => '0x')
    const v = await checkTokenOnChain(8453, arbTok, { getCode })
    expect(v).toMatchObject({ onChain: false })
    expect(getCode).toHaveBeenCalledWith(8453, arbTok) // asked on the ORDER's chain
  })

  it('undefined / "0x" code → false; real bytecode → true', async () => {
    expect((await checkTokenOnChain(8453, UNKNOWN, { getCode: async () => undefined })).onChain).toBe(false)
    _clearTokenOnChainCache()
    expect((await checkTokenOnChain(8453, UNKNOWN, { getCode: async () => '0x6080' })).onChain).toBe(true)
  })

  it('caches per (chainId,address) for 10 minutes, and chains are separate keys', async () => {
    const getCode = vi.fn(async () => '0x6080')
    await checkTokenOnChain(8453, UNKNOWN, { getCode })
    await checkTokenOnChain(8453, UNKNOWN.toUpperCase().replace('0X', '0x'), { getCode })
    expect(getCode).toHaveBeenCalledTimes(1)
    await checkTokenOnChain(42161, UNKNOWN, { getCode })
    expect(getCode).toHaveBeenCalledTimes(2)
    vi.setSystemTime(10 * 60_000 + 1)
    await checkTokenOnChain(8453, UNKNOWN, { getCode })
    expect(getCode).toHaveBeenCalledTimes(3)
  })

  it('an RPC failure is null (unverifiable), never a pass and never cached', async () => {
    const fail = vi.fn(async () => { throw new Error('down') })
    expect((await checkTokenOnChain(8453, UNKNOWN, { getCode: fail })).onChain).toBeNull()
    const ok = vi.fn(async () => '0x6080')
    expect((await checkTokenOnChain(8453, UNKNOWN, { getCode: ok })).onChain).toBe(true)
  })

  it('an unsupported chain is unverifiable (null)', async () => {
    expect((await checkTokenOnChain(999999, UNKNOWN, { getCode: async () => '0x6080' })).onChain).toBeNull()
  })
})
