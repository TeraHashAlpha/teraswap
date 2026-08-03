import { describe, it, expect } from 'vitest'
import { bitmapPositions, computeInvalidationBatches, isNonceInBatch } from './v3-nonce-bitmap'

describe('bitmapPositions', () => {
  it('nonce 0 -> word 0, bit 0', () => {
    expect(bitmapPositions(0n)).toEqual({ wordPos: 0n, bitPos: 0n })
  })

  it('nonce 255 -> word 0, bit 255 (last bit of word 0)', () => {
    expect(bitmapPositions(255n)).toEqual({ wordPos: 0n, bitPos: 255n })
  })

  it('nonce 256 -> word 1, bit 0 (first nonce of the next word)', () => {
    expect(bitmapPositions(256n)).toEqual({ wordPos: 1n, bitPos: 0n })
  })

  it('nonce 258 -> word 1, bit 2 (matches the contract test fixture)', () => {
    expect(bitmapPositions(258n)).toEqual({ wordPos: 1n, bitPos: 2n })
  })

  it('a large nonce still resolves correctly (word = nonce >> 8)', () => {
    const nonce = 1_000_000n
    const { wordPos, bitPos } = bitmapPositions(nonce)
    expect(wordPos).toBe(nonce >> 8n)
    expect(bitPos).toBe(nonce & 0xffn)
    expect(bitPos).toBeGreaterThanOrEqual(0n)
    expect(bitPos).toBeLessThan(256n)
  })
})

describe('computeInvalidationBatches', () => {
  it('empty input -> no batches', () => {
    expect(computeInvalidationBatches([])).toEqual([])
  })

  it('a single nonce -> one batch with exactly its bit set', () => {
    const batches = computeInvalidationBatches([5n])
    expect(batches).toEqual([{ wordPos: 0n, mask: 1n << 5n }])
  })

  it('multiple nonces in the SAME word -> ONE batch, OR-combined mask', () => {
    const batches = computeInvalidationBatches([1n, 3n, 7n])
    expect(batches).toHaveLength(1)
    expect(batches[0].wordPos).toBe(0n)
    expect(batches[0].mask).toBe((1n << 1n) | (1n << 3n) | (1n << 7n))
  })

  it('nonces spanning multiple words -> one batch per DISTINCT word', () => {
    const batches = computeInvalidationBatches([2n, 300n, 600n]) // words 0, 1, 2
    expect(batches).toHaveLength(3)
    const byWord = new Map(batches.map((b) => [b.wordPos, b.mask]))
    expect(byWord.get(0n)).toBe(1n << 2n)
    expect(byWord.get(1n)).toBe(1n << (300n - 256n))
    expect(byWord.get(2n)).toBe(1n << (600n - 512n))
  })

  it('duplicate nonces are idempotent — OR-ing the same bit twice changes nothing', () => {
    const once = computeInvalidationBatches([10n])
    const twice = computeInvalidationBatches([10n, 10n, 10n])
    expect(twice).toEqual(once)
  })

  it('input order does not affect the result', () => {
    const a = computeInvalidationBatches([5n, 300n, 1n])
    const b = computeInvalidationBatches([300n, 1n, 5n])
    const sortByWord = (batches: typeof a) => [...batches].sort((x, y) => Number(x.wordPos - y.wordPos))
    expect(sortByWord(a)).toEqual(sortByWord(b))
  })

  it('every nonce in the input is set in its resulting batch (round-trip property)', () => {
    const nonces = [0n, 1n, 255n, 256n, 257n, 511n, 512n, 1000n, 100_000n]
    const batches = computeInvalidationBatches(nonces)
    for (const nonce of nonces) {
      const { wordPos } = bitmapPositions(nonce)
      const batch = batches.find((b) => b.wordPos === wordPos)
      expect(batch, `no batch found for nonce ${nonce} (word ${wordPos})`).toBeDefined()
      expect(isNonceInBatch(nonce, batch!)).toBe(true)
    }
  })

  it('fuzz: random nonce sets always produce internally-consistent batches', () => {
    for (let trial = 0; trial < 50; trial++) {
      const count = 1 + Math.floor(Math.random() * 20)
      const nonces = Array.from({ length: count }, () => BigInt(Math.floor(Math.random() * 2000)))
      const batches = computeInvalidationBatches(nonces)

      // No two batches share a wordPos.
      const wordPositions = batches.map((b) => b.wordPos)
      expect(new Set(wordPositions).size).toBe(wordPositions.length)

      // Every input nonce is represented.
      for (const nonce of nonces) {
        const { wordPos } = bitmapPositions(nonce)
        const batch = batches.find((b) => b.wordPos === wordPos)!
        expect(isNonceInBatch(nonce, batch)).toBe(true)
      }

      // Every mask is within uint256 bit range (< 2^256) and non-zero.
      for (const b of batches) {
        expect(b.mask).toBeGreaterThan(0n)
        expect(b.mask).toBeLessThan(1n << 256n)
      }
    }
  })
})

describe('isNonceInBatch', () => {
  it('false for a nonce in a different word than the batch', () => {
    const batch = { wordPos: 0n, mask: 1n << 5n }
    expect(isNonceInBatch(300n, batch)).toBe(false) // word 1
  })

  it('false for a nonce in the right word but an unset bit', () => {
    const batch = { wordPos: 0n, mask: 1n << 5n }
    expect(isNonceInBatch(6n, batch)).toBe(false)
  })

  it('true only for the exact bit set', () => {
    const batch = { wordPos: 0n, mask: 1n << 5n }
    expect(isNonceInBatch(5n, batch)).toBe(true)
  })
})
