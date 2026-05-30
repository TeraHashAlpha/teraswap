// @vitest-environment node
/**
 * [P227] fetchApproveSpender — per-chain spender resolution (P226).
 */
import { describe, it, expect } from 'vitest'
import { fetchApproveSpender } from './api'
import { FEE_COLLECTOR_ADDRESS, PERMIT2_ADDRESS } from './constants'

describe('api — fetchApproveSpender per-chain [P226]', () => {
  it('returns the mainnet spender for chainId=1 (unchanged)', async () => {
    // 0x is FeeCollector-incompatible → its mainnet spender is Permit2.
    expect((await fetchApproveSpender('0x', 1)).toLowerCase()).toBe(PERMIT2_ADDRESS.toLowerCase())
    // 1inch routes through the FeeCollector → spender is the (mainnet) FeeCollector.
    expect((await fetchApproveSpender('1inch', 1)).toLowerCase()).toBe(FEE_COLLECTOR_ADDRESS.toLowerCase())
  })

  it('returns the Base spender for chainId=8453', async () => {
    // Base FeeCollector is null → fall through to the per-chain router whitelist.
    expect((await fetchApproveSpender('1inch', 8453)).toLowerCase()).toBe('0x111111125421ca6dc452d289314280a0f8842a65')
    // 0x on Base → the v2 AllowanceHolder (differs from the mainnet Permit2 spender).
    expect((await fetchApproveSpender('0x', 8453)).toLowerCase()).toBe('0x0000000000001ff3684f28c67538d4d072c22734')
  })
})
