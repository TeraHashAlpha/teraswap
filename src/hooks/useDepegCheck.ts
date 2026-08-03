import { useAccount, useReadContract } from 'wagmi'
import { chainlinkAggregatorAbi, getFeedStalenessSec } from '@/lib/chainlink'
import { getExchangeRatePair } from '@/lib/chains/chainlink-feeds'
import { evaluateDepeg, priceFromValidRound, hasReadFailed, PENDING, UNVERIFIED, type DepegCheck } from '@/lib/depeg-gate'
import { useResolvedChainId } from './useChainId'

/**
 * [SPRINT-9W-oracle] cbETH depeg circuit-breaker hook — a SECOND, independent verdict alongside the
 * 9J price-impact gate, computed from the divergence between a token's MARKET feed and its
 * EXCHANGE-RATE feed (the swap-price reference is unchanged — still the market feed via
 * useChainlinkPrice).
 *
 * For whichever token in the swap pair has BOTH feeds (data-driven via getExchangeRatePair —
 * cbETH on Base today, any future such asset by registry entry), it reads both feeds, validates
 * EACH leg (9G round integrity + 9V per-feed staleness), and returns the verdict.
 *
 * [FIX-ORACLE-FAIL-CLOSED] This hook used to FAIL OPEN: a read error, a revert, or a stale feed all
 * collapsed to mode 'ok', so the swap proceeded as if the peg had been verified when it had not been
 * checked at all. It now fails CLOSED. Four outcomes, each meaning exactly one thing:
 *
 *  - 'ok'         — checked, and the peg holds (or the check does not apply to this pair, see below)
 *  - 'consent' / 'block' — checked, and the peg is off by the WARN / BLOCK band (unchanged)
 *  - 'pending'    — the reads are in flight. A normal first render: frictionless, NOT a block.
 *  - 'unverified' — we tried and failed: read error, revert, missing feed on a registered pair,
 *                   failed round integrity, stale data, or an unresolved chain. BLOCKS, with copy
 *                   that says we could not check — never that the asset is depegged.
 *
 * The applicability distinction that keeps this from blocking the whole app: a token with NO
 * exchange-rate pair is 'ok', not 'unverified'. Only cbETH-on-Base has a pair today, so virtually
 * every swap resolves 'ok' here with zero reads issued. "No pair" means the depeg check does not
 * apply; "unverified" means it applies and we could not run it. Conflating the two would hard-block
 * every swap in the app.
 *
 * The four useReadContract calls are always invoked (fixed hook order) and gated by `enabled` so
 * non-pair swaps issue no RPC reads.
 */
export function useDepegCheck(
  tokenInAddress: string | undefined,
  tokenOutAddress: string | undefined,
): DepegCheck {
  // [FIX-ORACLE-FAIL-CLOSED] No `?? DEFAULT_CHAIN_ID` fallback here, deliberately: assuming mainnet
  // during a transient would resolve mainnet's (empty) pair registry and report a confident "no
  // depeg risk" for a token that in truth has a pair on the chain the user is actually on. A gate
  // must know which chain it guards. See useResolvedChainId.
  const chainId = useResolvedChainId()
  const { isConnected } = useAccount()

  const pair =
    chainId != null
      ? (tokenInAddress ? getExchangeRatePair(tokenInAddress, chainId) : null) ??
        (tokenOutAddress ? getExchangeRatePair(tokenOutAddress, chainId) : null)
      : null
  const enabled = !!pair

  // [FIX-ORACLE-FAIL-CLOSED] refetchInterval matches the sibling read hooks (useTokenBalance.ts:47,
  // useTokenBalances.ts:64, usePortfolio.ts:287). It is not cosmetic here: a query that settles into
  // `error` is NOT retried by TanStack on its own — only a focus/mount/reconnect event would revive
  // it — so without a poll an 'unverified' block could latch for the whole session view while the
  // UI promised it would clear on its own. Only fires when `enabled` (a registered pair), so the
  // ~100% of swaps with no exchange-rate pair still issue zero reads.
  const query = { enabled, refetchInterval: enabled ? 30_000 : undefined }

  const market = useReadContract({
    address: pair?.market, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData', chainId, query,
  })
  const marketDec = useReadContract({
    address: pair?.market, abi: chainlinkAggregatorAbi, functionName: 'decimals', chainId, query,
  })
  const er = useReadContract({
    address: pair?.exchangeRate, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData', chainId, query,
  })
  const erDec = useReadContract({
    address: pair?.exchangeRate, abi: chainlinkAggregatorAbi, functionName: 'decimals', chainId, query,
  })

  // [FIX-ORACLE-FAIL-CLOSED] Chain unresolved. Disconnected is NOT a failure — there is no swap to
  // guard and no chain to guard it on, so stay frictionless ('pending', the same no-friction shape a
  // first render has always had). But CONNECTED with an unresolvable chain (mid-switch, or an
  // unsupported chain) is exactly the transient where the old fallback-to-mainnet silently voided
  // this guard, so that blocks.
  if (chainId == null) return isConnected ? UNVERIFIED('') : PENDING('')

  // Not an asset with an exchange-rate feed → the depeg check does not APPLY (the common case).
  // Distinct from "applies but could not be checked" — see the header.
  if (!pair) return { mode: 'ok', divergence: 0, symbol: '', message: null }

  // A registered pair whose feed addresses are incomplete is a malformed registry entry, not a
  // healthy asset — we cannot check the peg, so we do not claim it holds.
  if (!pair.market || !pair.exchangeRate) return UNVERIFIED(pair.symbol)

  // A failed read (RPC error, revert, non-contract address) means the peg is UNVERIFIED. This is the
  // single most important line in the fix: it used to fall through to `undefined` data → null price
  // → 'ok'.
  if (market.isError || marketDec.isError || er.isError || erDec.isError) return UNVERIFIED(pair.symbol)

  const dataComplete =
    market.data !== undefined && marketDec.data !== undefined &&
    er.data !== undefined && erDec.data !== undefined
  if (!dataComplete) {
    // [FIX-ORACLE-FAIL-CLOSED] `isLoading` alone is NOT a safe test for "in flight". TanStack keeps
    // it true for the WHOLE retry sequence, so a read that has already failed twice and is sitting
    // in backoff still reports isLoading — and treating that as 'pending' would leave the gate
    // silently inactive for the entire backoff window, which is the very hole this fix closes.
    //
    // [FIX-DEPEG-RETRY-WINDOW / M-01] The burden of proof is INVERTED here. PENDING (frictionless)
    // is not the default for "no data yet" — it is granted ONLY to a read that has never failed. Any
    // read with failure history presents as UNVERIFIED for as long as it has no data, however
    // 'pending'-looking the library's own flags are. Checking `failureCount` alone was not enough:
    // the 30s poll resets it to 0 and rewinds `status` to 'pending', so the gate re-opened once per
    // cycle. `hasReadFailed` adds `errorUpdateCount`, which query-core never resets — see its docs.
    const anyFailure =
      hasReadFailed(market) || hasReadFailed(marketDec) || hasReadFailed(er) || hasReadFailed(erDec)
    const inFlight =
      (market.isLoading || marketDec.isLoading || er.isLoading || erDec.isLoading) && !anyFailure
    // Genuinely first-flight → pending (frictionless). Failing, or settled-but-empty → blocked.
    // Recovery is NOT via this branch: only a completed successful read (all four `data` present)
    // reaches the evaluation below, which is what "only success reopens the gate" means mechanically.
    return inFlight ? PENDING(pair.symbol) : UNVERIFIED(pair.symbol)
  }

  const now = Math.floor(Date.now() / 1000)
  // Each leg: 9G integrity + 9V per-feed staleness (heartbeat×1.5, else the 90_000 UI global —
  // matching useChainlinkPrice), decimals applied per-leg. getFeedStalenessSec is the SINGLE source
  // of truth for the threshold, shared with the raw gate and useChainlinkPrice; both cbETH legs have
  // a registered 86_400s heartbeat → 129_600s (36h). A failing leg → null → evaluateDepeg now
  // returns 'unverified' (blocking), where it previously returned 'ok' (fail-open).
  const marketPrice = priceFromValidRound(market.data, marketDec.data, getFeedStalenessSec(pair.market, 90_000), now)
  const erPrice = priceFromValidRound(er.data, erDec.data, getFeedStalenessSec(pair.exchangeRate, 90_000), now)

  return evaluateDepeg(marketPrice, erPrice, pair.symbol)
}
