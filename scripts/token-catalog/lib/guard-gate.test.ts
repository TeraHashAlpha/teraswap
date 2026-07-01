/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] deriveGuardOutcomes — maps the EXISTING catalog guard's
 * findings (src/lib/chains/catalog-guard.ts auditChain, reused verbatim) onto per-address
 * pipeline outcomes: pass / fatal / unverifiable. No on-chain check is reimplemented here.
 */
import { describe, it, expect } from 'vitest'
import type { Allowlist, Verdict } from '@/lib/chains/catalog-guard'
import { deriveGuardOutcomes } from './guard-gate'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const AL: Allowlist = { nativeEth: NATIVE, trustedListExempt: [], duplicateSymbolExempt: [] }

function verdict(p: Partial<Verdict>): Verdict {
  return {
    chainId: 1,
    address: WETH,
    symbol: 'WETH',
    inTrustedList: true,
    hasBytecode: true,
    transferable: true,
    onchainSymbol: 'WETH',
    decimals: 18,
    ...p,
  }
}

const token = (address: string, symbol: string, decimals: number) => ({ address, symbol, decimals })

describe('deriveGuardOutcomes', () => {
  it('clean verdict ⇒ pass', () => {
    const out = deriveGuardOutcomes(1, [token(WETH, 'WETH', 18)], [verdict({})], AL)
    expect(out.get(WETH.toLowerCase())).toEqual({ status: 'pass' })
  })

  it('dead address (no bytecode) ⇒ fatal', () => {
    const out = deriveGuardOutcomes(1, [token(WETH, 'WETH', 18)], [verdict({ hasBytecode: false, inTrustedList: false })], AL)
    expect(out.get(WETH.toLowerCase())?.status).toBe('fatal')
  })

  it('on-chain identity mismatch ⇒ fatal', () => {
    const out = deriveGuardOutcomes(1, [token(WETH, 'WETH', 18)], [verdict({ onchainSymbol: 'SCAM' })], AL)
    expect(out.get(WETH.toLowerCase())?.status).toBe('fatal')
  })

  it('on-chain decimals mismatch ⇒ fatal (fund-affecting)', () => {
    const out = deriveGuardOutcomes(1, [token(WETH, 'WETH', 6)], [verdict({ decimals: 18 })], AL)
    expect(out.get(WETH.toLowerCase())?.status).toBe('fatal')
  })

  it('trusted-list miss (non-exempt) ⇒ fatal', () => {
    const out = deriveGuardOutcomes(1, [token(WETH, 'WETH', 18)], [verdict({ inTrustedList: false })], AL)
    expect(out.get(WETH.toLowerCase())?.status).toBe('fatal')
  })

  it('missing verdict ⇒ fatal (the guard fails closed on verdict-cache)', () => {
    const out = deriveGuardOutcomes(1, [token(WETH, 'WETH', 18)], [], AL)
    expect(out.get(WETH.toLowerCase())?.status).toBe('fatal')
  })

  it('null on-chain signals (RPC unreachable) ⇒ unverifiable, not pass', () => {
    const out = deriveGuardOutcomes(
      1,
      [token(WETH, 'WETH', 18)],
      [verdict({ hasBytecode: null, transferable: null, onchainSymbol: null, decimals: null })],
      AL,
    )
    expect(out.get(WETH.toLowerCase())?.status).toBe('unverifiable')
  })

  it('transferable=false stays ADVISORY (pass) — USDT-style probes revert legitimately', () => {
    const out = deriveGuardOutcomes(1, [token(WETH, 'WETH', 18)], [verdict({ transferable: false })], AL)
    expect(out.get(WETH.toLowerCase())?.status).toBe('pass')
  })

  it('duplicate-symbol fatal marks EVERY colliding address', () => {
    const tokens = [token(WETH, 'WBTC', 18), token(DAI, 'WBTC', 18)]
    const verdicts = [verdict({ address: WETH, symbol: 'WBTC', onchainSymbol: 'WBTC' }), verdict({ address: DAI, symbol: 'WBTC', onchainSymbol: 'WBTC' })]
    const out = deriveGuardOutcomes(1, tokens, verdicts, AL)
    expect(out.get(WETH.toLowerCase())?.status).toBe('fatal')
    expect(out.get(DAI.toLowerCase())?.status).toBe('fatal')
  })

  it('the native sentinel is skipped by the guard and reported as pass', () => {
    const out = deriveGuardOutcomes(1, [token(NATIVE, 'ETH', 18)], [], AL)
    expect(out.get(NATIVE.toLowerCase())).toEqual({ status: 'pass' })
  })
})
