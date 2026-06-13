// @vitest-environment node
/**
 * [CHORE-ORDER-EXEC-PREP A] Chain-aware OrderExecutor resolution + fail-closed EIP-712 domain.
 *
 * CRITICAL: 0xeFC31ADb…f130 is the OrderExecutor on MAINNET (has executeOrder) but a FeeCollector
 * on BASE (no executeOrder — same address, different bytecode). So the order engine must resolve
 * per-chain and never sign/verify against a chain with no real executor. Mainnet (chainId 1) EIP-712
 * domain MUST stay byte-identical (verifyingContract = the mainnet executor).
 */
import { describe, it, expect } from 'vitest'
import { ORDER_EXECUTOR_BY_CHAIN, getOrderExecutor, getOrderExecutorDomain, ORDER_EXECUTOR_ADDRESS } from './config'

const MAINNET = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'

describe('chain-aware OrderExecutor [CHORE-ORDER-EXEC-PREP A]', () => {
  it('getOrderExecutor(1) = the mainnet OrderExecutor', () => {
    expect(getOrderExecutor(1)?.toLowerCase()).toBe(MAINNET.toLowerCase())
  })

  it('getOrderExecutor(8453) = null — NO Base executor (that address is the FeeCollector on Base)', () => {
    expect(getOrderExecutor(8453)).toBeNull()
    expect(ORDER_EXECUTOR_BY_CHAIN[8453]).toBeNull()
  })

  it('getOrderExecutor(unknown chain) = null (fail-closed)', () => {
    expect(getOrderExecutor(42161)).toBeNull()
  })

  it('getOrderExecutorDomain(1) is UNCHANGED — mainnet EIP-712 byte-identical', () => {
    expect(getOrderExecutorDomain(1)).toEqual({
      name: 'TeraSwapOrderExecutor',
      version: '2',
      chainId: 1,
      verifyingContract: MAINNET, // exact checksummed mainnet executor
    })
  })

  it('getOrderExecutorDomain(8453) THROWS — never sign/verify against a non-existent executor', () => {
    expect(() => getOrderExecutorDomain(8453)).toThrow(/OrderExecutor/i)
  })

  it('deprecated ORDER_EXECUTOR_ADDRESS alias resolves to the mainnet executor', () => {
    expect(ORDER_EXECUTOR_ADDRESS.toLowerCase()).toBe(MAINNET.toLowerCase())
  })
})
