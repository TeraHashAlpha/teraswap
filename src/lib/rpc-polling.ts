/**
 * [feat/frontend-rpc-diet] The browser's block-polling cadence, shared by the v1 and v2 footers so the two cannot
 * drift. The per-tab RPC budgets that pin it live in the `rpc-budget/guards.test.tsx` budget tests.
 *
 * TanStack's `refetchInterval` already pauses in hidden tabs (`refetchIntervalInBackground` defaults to false) and
 * stops when the last observer unmounts, so no extra visibility logic is needed here.
 */

/**
 * The footer's "Chain · Block #N". 60 s, not the block time: the figure is informational (a swap never reads it),
 * and a wallet-less visitor pays for nothing else — 60 s is the owner's ≤ 1 call/min budget for them.
 */
export const BLOCK_POLL_MS = 60_000
