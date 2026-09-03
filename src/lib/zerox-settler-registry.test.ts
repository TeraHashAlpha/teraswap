/**
 * [ADR-023] 0x Settler identity resolution — every RPC is MOCKED.
 *
 * These tests pin the fail-closed contract: the resolver returns exactly
 * {ownerOf(2), prev(2)} lower-cased on success, and THROWS on every other
 * outcome, so a caller can never mistake a failed lookup for an empty-but-valid
 * answer. The golden vectors below carry the real per-chain registry answers
 * read on 2026-09-03; they are used here as realistic data, not as a live call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  resolveZeroxSettlers,
  _clearZeroxSettlerCache,
  ZEROX_DEPLOYER_ADDRESS,
  ZEROX_TAKER_SUBMITTED_FEATURE_ID,
  ZEROX_SETTLER_CACHE_TTL_MS,
  type SettlerRegistryClient,
} from './zerox-settler-registry'
import {
  ZEROX_MAINNET_SETTLER_CURRENT,
  ZEROX_MAINNET_SETTLER_PREV,
} from './__fixtures__/zerox-allowance-holder-mainnet'
import {
  ZEROX_BASE_SETTLER_CURRENT,
  ZEROX_BASE_SETTLER_PREV,
} from './__fixtures__/zerox-allowance-holder-base'
import {
  ZEROX_ARBITRUM_SETTLER_CURRENT,
  ZEROX_ARBITRUM_SETTLER_PREV,
} from './__fixtures__/zerox-allowance-holder-arbitrum'

/** Some plausible 58-byte runtime; only "non-empty" matters to the resolver. */
const REGISTRY_CODE = `0x${'36'.repeat(58)}`

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

interface FakeOpts {
  code?: string | undefined
  codeThrows?: Error
  ownerOf?: unknown
  prev?: unknown
  ownerOfThrows?: Error
  prevThrows?: Error
  chain?: { id?: number } | null
}

function fakeClient(opts: FakeOpts = {}) {
  const getCode = vi.fn(async () => {
    if (opts.codeThrows) throw opts.codeThrows
    return 'code' in opts ? opts.code : REGISTRY_CODE
  })
  const readContract = vi.fn(async (args: { functionName: string; args: readonly [bigint] }) => {
    if (args.functionName === 'ownerOf') {
      if (opts.ownerOfThrows) throw opts.ownerOfThrows
      return 'ownerOf' in opts ? opts.ownerOf : ZEROX_MAINNET_SETTLER_CURRENT
    }
    if (opts.prevThrows) throw opts.prevThrows
    return 'prev' in opts ? opts.prev : ZEROX_MAINNET_SETTLER_PREV
  })
  const client = { getCode, readContract } as unknown as SettlerRegistryClient
  if ('chain' in opts) (client as { chain?: unknown }).chain = opts.chain
  return { client, getCode, readContract }
}

describe('[ADR-023] zerox-settler-registry', () => {
  beforeEach(() => {
    _clearZeroxSettlerCache()
    vi.useRealTimers()
  })

  // ── The two things that may not be derived by a call ──

  describe('pinned constants', () => {
    it('the deployer address is a well-formed 42-character address', () => {
      // The sentinel the goal asks for: 0x + 20 bytes. This is the ONE address
      // ADR-023 pins, because it is the root the rest is derived from.
      expect(ZEROX_DEPLOYER_ADDRESS).toHaveLength(42)
      expect(ZEROX_DEPLOYER_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('the feature id is the taker-submitted one (2), as a bigint', () => {
      // Derived from 0x's README ("For taker-submitted flows, the feature
      // number is probably 2") AND from live traffic: every sampled successful
      // exec on chains 1/8453/42161 targeted that chain's feature-2 address.
      expect(ZEROX_TAKER_SUBMITTED_FEATURE_ID).toBe(2n)
    })

    it('the cache TTL is short and positive', () => {
      expect(ZEROX_SETTLER_CACHE_TTL_MS).toBeGreaterThan(0)
      expect(ZEROX_SETTLER_CACHE_TTL_MS).toBeLessThanOrEqual(60_000)
    })
  })

  // ── Happy path ──

  describe('successful resolution', () => {
    it('returns exactly {ownerOf(2), prev(2)}, lower-cased', async () => {
      const { client } = fakeClient()
      const settlers = await resolveZeroxSettlers(1, client)
      expect([...settlers].sort()).toEqual(
        [
          ZEROX_MAINNET_SETTLER_CURRENT.toLowerCase(),
          ZEROX_MAINNET_SETTLER_PREV.toLowerCase(),
        ].sort(),
      )
    })

    it('queries the deployer address with the taker-submitted feature id', async () => {
      const { client, getCode, readContract } = fakeClient()
      await resolveZeroxSettlers(1, client)
      expect(getCode).toHaveBeenCalledWith({ address: ZEROX_DEPLOYER_ADDRESS })
      const fns = readContract.mock.calls.map((c) => c[0].functionName).sort()
      expect(fns).toEqual(['ownerOf', 'prev'])
      for (const call of readContract.mock.calls) {
        expect(call[0].args).toEqual([ZEROX_TAKER_SUBMITTED_FEATURE_ID])
      }
    })

    it('collapses to a single entry when ownerOf === prev (no rotation yet)', async () => {
      const { client } = fakeClient({
        ownerOf: ZEROX_MAINNET_SETTLER_CURRENT,
        prev: ZEROX_MAINNET_SETTLER_CURRENT,
      })
      const settlers = await resolveZeroxSettlers(1, client)
      expect(settlers.size).toBe(1)
      expect(settlers.has(ZEROX_MAINNET_SETTLER_CURRENT.toLowerCase())).toBe(true)
    })
  })

  // ── Acceptance 2 — three fail-closed cases, each REJECTED ──

  describe('fail-closed', () => {
    it('REJECTS when the registry read throws', async () => {
      const { client } = fakeClient({ ownerOfThrows: new Error('execution reverted') })
      await expect(resolveZeroxSettlers(1, client)).rejects.toThrow(/ownerOf\(2\) failed on chain 1/)
    })

    it('REJECTS when the registry returns 0x (empty returndata)', async () => {
      const { client } = fakeClient({ ownerOf: '0x' })
      await expect(resolveZeroxSettlers(1, client)).rejects.toThrow(/malformed address on chain 1/)
    })

    it('REJECTS when the registry returns the zero address', async () => {
      const { client } = fakeClient({ ownerOf: ZERO_ADDRESS })
      await expect(resolveZeroxSettlers(1, client)).rejects.toThrow(/zero address on chain 1/)
    })

    it('REJECTS a zero address from prev too, not just ownerOf', async () => {
      const { client } = fakeClient({ prev: ZERO_ADDRESS })
      await expect(resolveZeroxSettlers(1, client)).rejects.toThrow(/prev\(2\) returned the zero address/)
    })

    it('REJECTS a reverting prev — the dwell fallback is not optional', async () => {
      const { client } = fakeClient({ prevThrows: new Error('execution reverted') })
      await expect(resolveZeroxSettlers(1, client)).rejects.toThrow(/prev\(2\) failed on chain 1/)
    })

    it('REJECTS a non-string / non-address answer', async () => {
      const { client } = fakeClient({ ownerOf: 42 })
      await expect(resolveZeroxSettlers(1, client)).rejects.toThrow(/malformed address/)
    })

    it('REJECTS a short hex answer that is not 20 bytes', async () => {
      const { client } = fakeClient({ ownerOf: '0xdeadbeef' })
      await expect(resolveZeroxSettlers(1, client)).rejects.toThrow(/malformed address/)
    })
  })

  // ── eth_getCode gate — the registry must exist on THIS chain ──

  describe('registry deployment check (eth_getCode)', () => {
    it('REJECTS a chain where the registry has no code', async () => {
      const { client, readContract } = fakeClient({ code: '0x' })
      await expect(resolveZeroxSettlers(999, client)).rejects.toThrow(/has no code on chain 999/)
      // …and never even asks the registry for an address.
      expect(readContract).not.toHaveBeenCalled()
    })

    it('REJECTS when getCode returns undefined', async () => {
      const { client } = fakeClient({ code: undefined })
      await expect(resolveZeroxSettlers(999, client)).rejects.toThrow(/has no code on chain 999/)
    })

    it('REJECTS when getCode itself throws', async () => {
      const { client } = fakeClient({ codeThrows: new Error('rpc down') })
      await expect(resolveZeroxSettlers(1, client)).rejects.toThrow(/code read failed on chain 1/)
    })
  })

  // ── No cross-chain contamination ──

  describe('per-chain isolation', () => {
    it('never returns one chain’s answer for another chain', async () => {
      const mainnet = fakeClient()
      const base = fakeClient({
        ownerOf: ZEROX_BASE_SETTLER_CURRENT,
        prev: ZEROX_BASE_SETTLER_PREV,
      })
      const arbitrum = fakeClient({
        ownerOf: ZEROX_ARBITRUM_SETTLER_CURRENT,
        prev: ZEROX_ARBITRUM_SETTLER_PREV,
      })

      const one = await resolveZeroxSettlers(1, mainnet.client)
      const b = await resolveZeroxSettlers(8453, base.client)
      const a = await resolveZeroxSettlers(42161, arbitrum.client)

      expect(one.has(ZEROX_BASE_SETTLER_PREV.toLowerCase())).toBe(false)
      expect(b.has(ZEROX_MAINNET_SETTLER_PREV.toLowerCase())).toBe(false)
      expect(a.has(ZEROX_BASE_SETTLER_PREV.toLowerCase())).toBe(false)
      expect(b.has(ZEROX_BASE_SETTLER_PREV.toLowerCase())).toBe(true)
      expect(a.has(ZEROX_ARBITRUM_SETTLER_PREV.toLowerCase())).toBe(true)
    })

    it('REJECTS a client that is bound to a different chain', async () => {
      const { client } = fakeClient({ chain: { id: 8453 } })
      await expect(resolveZeroxSettlers(1, client)).rejects.toThrow(
        /bound to chain 8453, not 1/,
      )
    })

    it('accepts a client whose chain matches, and one with no chain at all', async () => {
      const matching = fakeClient({ chain: { id: 1 } })
      await expect(resolveZeroxSettlers(1, matching.client)).resolves.toBeInstanceOf(Set)
      _clearZeroxSettlerCache()
      const anonymous = fakeClient({ chain: null })
      await expect(resolveZeroxSettlers(1, anonymous.client)).resolves.toBeInstanceOf(Set)
    })
  })

  // ── Cache behaviour ──

  describe('cache', () => {
    it('reuses a success within the TTL instead of re-reading', async () => {
      const { client, getCode, readContract } = fakeClient()
      await resolveZeroxSettlers(1, client)
      await resolveZeroxSettlers(1, client)
      expect(getCode).toHaveBeenCalledTimes(1)
      expect(readContract).toHaveBeenCalledTimes(2) // ownerOf + prev, once
    })

    it('re-reads once the TTL has elapsed', async () => {
      vi.useFakeTimers()
      try {
        const { client, getCode } = fakeClient()
        await resolveZeroxSettlers(1, client)
        vi.setSystemTime(Date.now() + ZEROX_SETTLER_CACHE_TTL_MS + 1)
        await resolveZeroxSettlers(1, client)
        expect(getCode).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does NOT cache a failure — the next swap retries', async () => {
      const failing = fakeClient({ ownerOfThrows: new Error('rpc down') })
      await expect(resolveZeroxSettlers(1, failing.client)).rejects.toThrow()

      const healthy = fakeClient()
      const settlers = await resolveZeroxSettlers(1, healthy.client)
      expect(settlers.size).toBe(2)
      expect(healthy.getCode).toHaveBeenCalledTimes(1)
    })

    it('single-flights concurrent misses into ONE read', async () => {
      const { client, getCode } = fakeClient()
      const [a, b, c] = await Promise.all([
        resolveZeroxSettlers(1, client),
        resolveZeroxSettlers(1, client),
        resolveZeroxSettlers(1, client),
      ])
      expect(getCode).toHaveBeenCalledTimes(1)
      expect(a).toBe(b)
      expect(b).toBe(c)
    })

    it('a rejected in-flight read is not left behind for the next caller', async () => {
      const failing = fakeClient({ codeThrows: new Error('rpc down') })
      await Promise.all([
        expect(resolveZeroxSettlers(1, failing.client)).rejects.toThrow(),
        expect(resolveZeroxSettlers(1, failing.client)).rejects.toThrow(),
      ])
      const healthy = fakeClient()
      await expect(resolveZeroxSettlers(1, healthy.client)).resolves.toBeInstanceOf(Set)
    })
  })
})
