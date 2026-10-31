'use client'

import type { PriceCheck } from '@/lib/chainlink'
import { UNVERIFIED_SWAP_BLOCK_USD } from '@/lib/constants'
import { fmtInt, fmtPct } from '@/lib/format'
import { Notice } from '../QuotePanel'
import type { SwapGateState } from './use-swap-gates'

const Sub = ({ children }: { children: string }) => <span className="mt-1 block text-[12px] text-v2-muted">{children}</span>
const Warn = () => <span aria-hidden="true">⚠ </span>

function Consent({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: string }) {
  return (
    <label className="mt-2 flex min-h-[44px] cursor-pointer items-center gap-3 text-[13px] text-v2-text">
      <input type="checkbox" data-testid={id} checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#EADFB6]" />
      {children}
    </label>
  )
}

/**
 * [B5] v1's price-gate banners (SwapBox, between the quote and the Swap button), same conditions and same words. The two
 * recoverable states carry v1's consent checkboxes; every other state is a hard block with no click-through. `stale` is v1's
 * `priceCheckStale` (the amount changed and no fresh quote has landed): the banners wait so they never flash on old data.
 */
export function GateNotices({ gates, pairCheck, hasQuote, hasAmount, stale, priceGuard }: { gates: SwapGateState; pairCheck: PriceCheck; hasQuote: boolean; hasAmount: boolean; stale: boolean; priceGuard?: { blocked: boolean; deviation: number | null } }) {
  const g = gates
  const live = hasAmount && hasQuote
  return (
    <div className="flex flex-col gap-3" data-testid="gate-notices">
      {priceGuard?.blocked && (
        <Notice tone="red" testId="gate-server-guard">
          <span className="font-semibold">Swap blocked by server-side price protection.</span> The swap output is {priceGuard.deviation != null ? fmtPct(Math.abs(priceGuard.deviation) * 100, 1) : 'significantly'} below the fair market price verified by DefiLlama oracle. This may indicate extreme slippage, low liquidity, or a mispriced token.
          <Sub>Try a smaller amount, a different token pair, or wait for liquidity to stabilize. This protection cannot be overridden.</Sub>
        </Notice>
      )}
      {g.oracleIntegrityBlocked && !g.isExtremeBlock && !stale && live && (
        <Notice tone="red" testId="gate-oracle-integrity">
          <span className="font-semibold"><Warn />Swap blocked — oracle data unsafe.</span> {pairCheck.message ?? 'The Chainlink price feed is stale or invalid, so this swap price cannot be independently verified.'}
          <Sub>This guards against trading on a manipulated or outdated oracle and cannot be overridden. Try again once the feed updates.</Sub>
        </Notice>
      )}
      {g.isExtremeBlock && !stale && (
        <Notice tone="red" testId="gate-extreme">
          <span className="font-semibold"><Warn />Swap blocked:</span> price deviates {fmtPct(pairCheck.deviation * 100, 1)} from the Chainlink oracle — far beyond normal price impact.
          <Sub>This likely indicates price manipulation or a broken quote and cannot be overridden. Try a smaller amount or a different pair.</Sub>
        </Notice>
      )}
      {g.priceImpactConsentNeeded && !stale && (
        <Notice tone="amber" testId="gate-price-impact">
          <span className="font-semibold"><Warn />High price impact:</span> this route executes ~{fmtPct(pairCheck.deviation * 100, 1)} below the Chainlink reference price — expected slippage on a low-liquidity route, not an oracle problem.
          <Consent id="gate-price-impact-checkbox" checked={g.priceImpactAccepted} onChange={g.setPriceImpactAccepted}>I understand the price impact and want to proceed.</Consent>
        </Notice>
      )}
      {g.depegHardBlocked && !stale && (
        <Notice tone="red" testId="gate-depeg-block">
          <span className="font-semibold"><Warn />Swap blocked — {g.depegCheck.symbol} depeg.</span> {g.depegCheck.message}
          <Sub>The market price has diverged sharply from the protocol exchange rate — likely a depeg or oracle manipulation. This cannot be overridden. Try again once the prices reconverge.</Sub>
        </Notice>
      )}
      {g.depegUnverified && live && !stale && (
        <Notice tone="red" testId="gate-depeg-unverified">
          <span className="font-semibold"><Warn />Swap paused — price not verified.</span> {g.depegCheck.message}
          <Sub>We could not get usable price-feed data to check this asset against its exchange rate, so we are not letting the swap through on a price we have not verified. This is not itself a depeg finding — we have not been able to make one either way. It clears once the feeds return good data.</Sub>
        </Notice>
      )}
      {g.depegConsentNeeded && !stale && (
        <Notice tone="amber" testId="gate-depeg-consent">
          <span className="font-semibold"><Warn />Possible depeg:</span> {g.depegCheck.message}
          <Consent id="gate-depeg-checkbox" checked={g.depegAccepted} onChange={g.setDepegAccepted}>{`I understand ${g.depegCheck.symbol} may be depegged and want to proceed.`}</Consent>
        </Notice>
      )}
      {g.oracleUnavailable && live && !g.priceGateBlocked &&
        (g.oracleBlocked ? (
          <Notice tone="red" testId="gate-no-oracle-block">
            <span className="font-semibold"><Warn />Swap blocked — no oracle verification.</span> This token has no Chainlink price feed. Swaps above ${fmtInt(UNVERIFIED_SWAP_BLOCK_USD)} are disabled when the price cannot be independently verified.
            <Sub>This protects against catastrophic losses from mispriced tokens (wrapped tokens, rebasing tokens, exotic pairs). Reduce the amount or swap a token with oracle coverage.</Sub>
          </Notice>
        ) : g.oracleWarnThreshold ? (
          <Notice tone="amber" testId="gate-no-oracle-warn">
            <span className="font-semibold"><Warn />No oracle verification — high value swap.</span> This token has no Chainlink price feed. The quoted price cannot be independently verified. Swaps above ${fmtInt(UNVERIFIED_SWAP_BLOCK_USD)} will be blocked.
            <Sub>Verify the price manually on CoinGecko or Etherscan before proceeding.</Sub>
          </Notice>
        ) : null)}
    </div>
  )
}
