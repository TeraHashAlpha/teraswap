/**
 * [FULL-H-02] Unit tests for the client-side spender allowlist.
 *
 * The critical invariant: every spender address that fetchApproveSpender()
 * can legitimately return MUST be in the trusted set — otherwise real swap
 * flows break. Equally, an arbitrary attacker address must be rejected.
 */
import { describe, it, expect } from 'vitest'
import { isTrustedSpender, TRUSTED_SPENDER_ADDRESSES } from './trusted-addresses'
import { fetchApproveSpender } from './api'
import {
  FEE_COLLECTOR_ADDRESS,
  FEE_COLLECTOR_V1_ADDRESS,
  PERMIT2_ADDRESS,
  COW_VAULT_RELAYER,
  AGGREGATOR_APIS,
  type AggregatorName,
} from './constants'

describe('trusted-addresses [FULL-H-02]', () => {
  it('trusts FeeCollector V2/V1, Permit2 and the CoW vault relayer', () => {
    expect(isTrustedSpender(FEE_COLLECTOR_ADDRESS)).toBe(true)
    expect(isTrustedSpender(FEE_COLLECTOR_V1_ADDRESS)).toBe(true)
    expect(isTrustedSpender(PERMIT2_ADDRESS)).toBe(true)
    expect(isTrustedSpender(COW_VAULT_RELAYER)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isTrustedSpender(PERMIT2_ADDRESS.toUpperCase())).toBe(true)
    expect(isTrustedSpender(PERMIT2_ADDRESS.toLowerCase())).toBe(true)
  })

  it('rejects an unknown attacker address', () => {
    expect(isTrustedSpender('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false)
  })

  it('trusts every spender fetchApproveSpender() returns for every source', async () => {
    const sources = Object.keys(AGGREGATOR_APIS) as AggregatorName[]
    for (const source of sources) {
      let spender: string
      try {
        spender = await fetchApproveSpender(source)
      } catch {
        // Unknown/pseudo sources may throw — they never reach an approval.
        continue
      }
      expect(
        isTrustedSpender(spender),
        `spender for "${source}" (${spender}) must be in the trusted allowlist`,
      ).toBe(true)
    }
  })

  it('contains no empty or zero-address entries', () => {
    expect(TRUSTED_SPENDER_ADDRESSES.has('')).toBe(false)
    expect(TRUSTED_SPENDER_ADDRESSES.has('0x0000000000000000000000000000000000000000')).toBe(false)
  })
})
