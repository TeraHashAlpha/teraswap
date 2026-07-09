/**
 * [SPRINT-V3-P3 / ADR-013 §3] Pure Permit2-style unordered-nonce bitmap math for v3 mass-cancel.
 *
 * Mirrors TeraSwapOrderExecutorV3.sol's bitmapPositions(nonce) exactly:
 *   wordPos = nonce >> 8   (each word covers 256 nonces)
 *   bitPos  = nonce & 0xff
 *
 * `invalidateUnorderedNonces(wordPos, mask)` ORs `mask` into the on-chain word — set bits can
 * only ever be added, never cleared, so re-submitting a batch that includes an already-cancelled
 * nonce is a safe no-op (idempotent). This module computes the minimal set of (wordPos, mask)
 * calls needed to invalidate an arbitrary list of nonces, batching every nonce that shares a word
 * into ONE call.
 *
 * Pure + never-throwing: no I/O, no chain reads — the caller supplies the nonces to invalidate
 * (typically every outstanding v3 order's signed nonce).
 */

export interface BitmapPosition {
  wordPos: bigint
  bitPos: bigint
}

/** Split a nonce into its (wordPos, bitPos) bitmap coordinates — mirrors the contract exactly. */
export function bitmapPositions(nonce: bigint): BitmapPosition {
  return { wordPos: nonce >> 8n, bitPos: nonce & 0xffn }
}

export interface InvalidationBatch {
  wordPos: bigint
  mask: bigint
}

/**
 * Compute the minimal (wordPos, mask) call set that invalidates every nonce in `nonces`.
 * Nonces sharing a wordPos are OR-combined into a single mask (one on-chain call per DISTINCT
 * word, not per nonce). Duplicate nonces are idempotent (OR-ing the same bit twice is a no-op).
 * Order of the input array does not affect the result.
 */
export function computeInvalidationBatches(nonces: bigint[]): InvalidationBatch[] {
  const maskByWord = new Map<bigint, bigint>()
  for (const nonce of nonces) {
    const { wordPos, bitPos } = bitmapPositions(nonce)
    const bit = 1n << bitPos
    maskByWord.set(wordPos, (maskByWord.get(wordPos) ?? 0n) | bit)
  }
  return Array.from(maskByWord.entries()).map(([wordPos, mask]) => ({ wordPos, mask }))
}

/** True when `nonce`'s bit is set in `mask` at `wordPos` — mirrors the contract's isNonceUsed. */
export function isNonceInBatch(nonce: bigint, batch: InvalidationBatch): boolean {
  const { wordPos, bitPos } = bitmapPositions(nonce)
  if (wordPos !== batch.wordPos) return false
  return (batch.mask & (1n << bitPos)) !== 0n
}
