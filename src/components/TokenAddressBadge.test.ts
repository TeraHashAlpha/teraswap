import { describe, expect, it } from 'vitest'
import { isAddress } from 'viem'

// TokenAddressBadge guards the Etherscan explorer link with `isAddress(address)`
// to prevent href injection (CodeQL CQL-10). These tests pin the guard semantics:
// valid addresses pass, anything else is rejected — including the malformed
// strings that the TypeScript `0x${string}` template type cannot reject at runtime.
describe('TokenAddressBadge — Etherscan href guard (CQL-10)', () => {
  it('accepts a valid checksummed address', () => {
    expect(isAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true)
  })

  it('accepts a valid lowercase address', () => {
    expect(isAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true)
  })

  it('rejects a non-address string', () => {
    expect(isAddress('not-an-address')).toBe(false)
  })

  it('rejects a javascript: scheme injection attempt', () => {
    expect(isAddress('javascript:alert(1)')).toBe(false)
  })

  it('rejects an address with embedded path traversal', () => {
    expect(isAddress('0x0000000000000000000000000000000000000000/../evil')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isAddress('')).toBe(false)
  })

  it('rejects a short hex string', () => {
    expect(isAddress('0xdeadbeef')).toBe(false)
  })
})
