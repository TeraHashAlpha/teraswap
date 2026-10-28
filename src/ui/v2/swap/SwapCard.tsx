'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, useBalance } from 'wagmi'
import { formatUnits } from 'viem'
import DigitRoller from '@/components/DigitRoller'
import ChainIcon from '@/components/icons/ChainIcon'
import { calculateAutoSlippage } from '@/components/SlippageModal'
import { useQuote } from '@/hooks/useQuote'
import { useQuoteChainId } from '@/hooks/useChainId'
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice'
import { useEthGasCost } from '@/hooks/useEthGasCost'
import { useApproval } from '@/hooks/useApproval'
import { quoteMatchesSelection } from '@/lib/quote-identity'
import { scopeToExecutable } from '@/lib/executable-sources'
import { selectBestWithMevPreference } from '@/lib/mev-preference'
import { shouldShowSourceToggle } from '@/lib/ui/source-toggle-visibility'
import { evaluatePairOracle } from '@/lib/chainlink'
import { isUsdStablecoin } from '@/lib/chains/stablecoins'
import { isChainActive, getChainConfig, remapTokenToChain } from '@/lib/chains'
import { isTrustedSpender } from '@/lib/trusted-addresses'
import { findToken, isNativeETH, type Token } from '@/lib/tokens'
import { AGGREGATOR_META, DEFAULT_SLIPPAGE, MEV_PREFERENCE_THRESHOLD } from '@/lib/constants'
import { fmtToken, formatWithSeparator, stripSeparator, fmtUsd } from '@/lib/format'
import { isVerifiedToken } from '@/lib/chains/tokens'
import { safeBigInt } from '@/lib/utils'
import { Button, Input, Skeleton, Surface, Toggle } from '../primitives'
import { shortAddress } from '../shell/format-address'
import './swap.css'
import { ctaFor } from './cta'
import { buildQuoteView, quoteIsForAmount } from './quote-model'
import { QuotePanel, Notice } from './QuotePanel'
import { SourcesMenu } from './SourcesMenu'
import { Tip } from './Tip'
import { TokenButton } from './TokenButton'

const MEV_HINT_KEY = 'teraswap:mev-hint-dismissed' // v1's key: one dismissal across v1 and v2

/** README §3: the thousands separator is a thin space. v1's `formatWithSeparator` groups with U+0020 (and `stripSeparator` eats `\s`, thin space included). */
const thin = (s: string) => s.replace(/ /g, ' ')

function TokenIdentity({ token, chainId }: { token: Token; chainId: number }) {
  const [copied, setCopied] = useState(false)
  if (isNativeETH(token)) return <span className="text-[12px] text-v2-muted">Native asset</span>
  const verified = isVerifiedToken(token.address, chainId)
  return (
    <span className="inline-flex items-center gap-2 font-v2-mono text-[12px] text-v2-muted">
      <span
        title={verified ? 'Verified — identity cross-checked across catalog sources. Not an endorsement: receipt/wrapped tokens (e.g. aUSDC) are verified too.' : 'Imported token — verify the address before trading'}
        className={verified ? 'text-v2-green' : 'text-v2-amber'}
      >
        <span aria-hidden="true">{verified ? '✓' : '⚠'}</span>
      </span>
      <span title={token.address}>{shortAddress(token.address)}</span>
      <button
        type="button"
        aria-label="Copy contract address"
        title={copied ? 'Copied!' : 'Copy address'}
        onClick={() => {
          navigator.clipboard?.writeText(token.address).catch(() => {})
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="inline-flex min-h-[44px] items-center px-1 text-v2-muted hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
      >
        <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      </button>
    </span>
  )
}

/**
 * [ADR-025] The Swap tab (B3): round7 frames 20 / 21a / 21b. It reuses v1's hooks UNCHANGED — the same quote, oracle, gas
 * and approval-plan reads SwapBox makes — and is display-only: the wallet lifecycle (review sheet, signing, approvals,
 * price gates) is B4/B5, so the CTA says the right thing but its click path is not wired here (`data-b5-stub`).
 */
export function SwapCard() {
  const [selectedIn, setSelectedIn] = useState<Token | null>(findToken('ETH') ?? null)
  const [selectedOut, setSelectedOut] = useState<Token | null>(findToken('USDC') ?? null)
  const [displayAmountIn, setDisplayAmountIn] = useState('')
  const [spenderAnswer, setSpenderAnswer] = useState<{ key: string; spender: `0x${string}` | undefined } | null>(null)
  const [mevProtected, setMevProtected] = useState(false)
  // The exposure hint is only ever shown next to a quote (client state), so reading storage in the initialiser cannot mismatch SSR.
  const [mevHintDismissed, setMevHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(MEV_HINT_KEY) === '1'
    } catch {
      return false // storage disabled — treat as not dismissed
    }
  })
  const [excludedSources, setExcludedSources] = useState<Set<string>>(new Set())

  const dismissMevHint = useCallback(() => {
    setMevHintDismissed(true)
    try {
      localStorage.setItem(MEV_HINT_KEY, '1')
    } catch {
      /* session-only dismissal is still useful */
    }
  }, [])
  const toggleSource = useCallback((source: string) => {
    setExcludedSources((prev) => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
  }, [])

  const amountIn = stripSeparator(displayAmountIn)
  const { address, isConnected, chain } = useAccount()
  const isCorrectChain = !!chain && isChainActive(chain.id)
  // Quoting is a READ: it needs inputs, not an account (feat/quote-before-wallet) — chain-correctness only gates once connected.
  const isChainOkForQuote = !isConnected || isCorrectChain
  const activeChainId = useQuoteChainId()

  // v1 re-resolves the selected tokens to the ACTIVE chain's addresses in an effect (the defaults are mainnet's); here the
  // selection is state and the chain's token is derived, so there is never a render with a Base pair on mainnet addresses.
  const tokenIn = useMemo(() => remapTokenToChain(selectedIn, activeChainId), [selectedIn, activeChainId])
  const tokenOut = useMemo(() => remapTokenToChain(selectedOut, activeChainId), [selectedOut, activeChainId])
  // Auto slippage (v1's default mode). The editor is a B4 modal, so until then the value is derived, not stored.
  const slippage = tokenIn && tokenOut ? calculateAutoSlippage(tokenIn.symbol, tokenOut.symbol, activeChainId) : DEFAULT_SLIPPAGE

  const { data: balanceIn } = useBalance({
    address,
    chainId: activeChainId,
    token: tokenIn && !isNativeETH(tokenIn) ? tokenIn.address : undefined,
    query: { enabled: isConnected && isCorrectChain && !!tokenIn },
  })

  const excludeArray = useMemo(() => (excludedSources.size > 0 ? Array.from(excludedSources) : undefined), [excludedSources])
  const { meta: rawMeta, loading: quoteLoading, error: quoteError, countdown, refresh: refreshQuote } = useQuote(tokenIn, tokenOut, amountIn, isChainOkForQuote, excludeArray)

  // [fix/stale-quote-pair-flip #604] Only a quote whose identity matches the CURRENT chain/pair/decimals feeds the display.
  const matchedRawMeta = useMemo(
    () => (rawMeta && quoteMatchesSelection(rawMeta.identity, { chainId: activeChainId, tokenIn, tokenOut }) ? rawMeta : null),
    [rawMeta, activeChainId, tokenIn, tokenOut],
  )
  const { meta: pickedMeta, smartMevApplied, mevExposedBest } = useMemo(
    () => selectBestWithMevPreference(scopeToExecutable(matchedRawMeta, activeChainId), mevProtected, AGGREGATOR_META, MEV_PREFERENCE_THRESHOLD),
    [matchedRawMeta, mevProtected, activeChainId],
  )
  // …and, new in v2, only while it answers the amount that is in the field (see quoteIsForAmount).
  const quoteCurrent = !!pickedMeta && !!tokenIn && quoteIsForAmount(matchedRawMeta?.identity.amountRaw, amountIn, tokenIn.decimals)
  const meta = quoteCurrent ? pickedMeta : null
  const quoteDecimalsOut = matchedRawMeta?.identity.decimalsOut ?? null

  const chainName = (() => {
    try {
      return getChainConfig(activeChainId).name
    } catch {
      return 'this network'
    }
  })()

  // The approval plan v1 shows as the "Approval" row — same spender fetch + allow-list check as SwapBox, read-only here.
  const spenderKey = meta?.best.source ? `${meta.best.source}:${activeChainId}` : null
  useEffect(() => {
    if (!spenderKey || !meta?.best.source) return
    const controller = new AbortController()
    fetch(`/api/spender?source=${meta.best.source}${activeChainId !== 1 ? `&chainId=${activeChainId}` : ''}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (!data.spender) return
        // [FULL-H-02] a compromised /api/spender must never become a trusted spender
        setSpenderAnswer({ key: spenderKey, spender: isTrustedSpender(data.spender, activeChainId) ? (data.spender as `0x${string}`) : undefined })
      })
      .catch(() => {})
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spenderKey is (source, chain); `meta` itself changes every poll
  }, [spenderKey])
  // An answer only counts for the (source, chain) it was fetched for — the "clear when there is no quote" of v1, derived.
  const spender = spenderAnswer && spenderAnswer.key === spenderKey ? spenderAnswer.spender : undefined
  const { plan: approvalPlan } = useApproval(tokenIn, amountIn, spender)

  // Direction-agnostic execution price (SwapBox, SPRINT-9S S2): the non-stable side priced off the stable side.
  const { execIn, execOut } =
    meta?.best && tokenIn && tokenOut && quoteDecimalsOut !== null
      ? (() => {
          const outBig = safeBigInt(meta.best.toAmount)
          if (outBig === null) return { execIn: null, execOut: null }
          const outAmount = Number(formatUnits(outBig, quoteDecimalsOut))
          const inAmount = Number(amountIn)
          if (inAmount <= 0 || outAmount <= 0) return { execIn: null, execOut: null }
          return {
            execIn: isUsdStablecoin(tokenOut.symbol, activeChainId) ? outAmount / inAmount : null,
            execOut: isUsdStablecoin(tokenIn.symbol, activeChainId) ? inAmount / outAmount : null,
          }
        })()
      : { execIn: null, execOut: null }
  const priceCheck = useChainlinkPrice(tokenIn?.address, execIn)
  const tokenOutPriceCheck = useChainlinkPrice(tokenOut?.address, execOut)
  const pairCheck = evaluatePairOracle(priceCheck, tokenOutPriceCheck, tokenIn?.symbol ?? '', tokenOut?.symbol ?? '')
  const { estimate: gasEstimate } = useEthGasCost()

  const hasAmount = !!amountIn && Number(amountIn) > 0
  const quoting = hasAmount && !meta && (quoteLoading || (!!pickedMeta && !quoteCurrent))
  const cta = ctaFor({ isConnected, hasAmount, quoteLoading: quoting, hasQuote: !!meta })

  // Cheap and pure; not memoised because useEthGasCost rebuilds `gasEstimate` on every render (v1 passes it straight through too).
  const view =
    meta && tokenIn && tokenOut && hasAmount
      ? buildQuoteView({ meta, tokenIn, tokenOut, amountIn, slippage, chainId: activeChainId, tokenInUsdPrice: priceCheck.chainlinkPrice, tokenOutUsdPrice: tokenOutPriceCheck.chainlinkPrice, gasEstimate })
      : null

  const outputDisplay =
    meta?.best && quoteDecimalsOut !== null
      ? (() => {
          const v = safeBigInt(meta.best.toAmount)
          return v !== null ? fmtToken(v, quoteDecimalsOut) : '—'
        })()
      : '0.0'
  const balanceDisplay = balanceIn ? fmtToken(balanceIn.value, balanceIn.decimals) : null

  function setAmount(clean: string) {
    setDisplayAmountIn(thin(formatWithSeparator(clean)))
  }
  function onAmountChange(raw: string) {
    const clean = raw.replace(/\s/g, '')
    if (clean === '' || /^\d*\.?\d*$/.test(clean)) setAmount(clean)
  }
  function invert() {
    setSelectedIn(tokenOut)
    setSelectedOut(tokenIn)
    setDisplayAmountIn('')
  }

  const showSources = shouldShowSourceToggle(meta?.all.length ?? null, excludedSources.size)

  return (
    <section data-swap-card="" data-quoting={quoting ? '' : undefined} aria-label="Swap" className="ts-swap">
      <Surface edge="top" className="ts-swap-card">
        <div className="mb-3 flex items-center gap-2 pt-4">
          <ChainIcon chainId={activeChainId} className="h-4 w-4 shrink-0" />
          <span className="font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted">{chainName}</span>
        </div>

        <div>
          <label htmlFor="v2-swap-sell" className="font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted">
            Sell
          </label>
          <div className="ts-swap-field">
            <Input
              id="v2-swap-sell"
              scale="amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              value={displayAmountIn}
              onChange={(e) => onAmountChange(e.target.value)}
              aria-label="Sell amount"
            />
            <TokenButton token={tokenIn} side="sell" />
          </div>
          {tokenIn && (
            <div className="mt-1 flex items-center justify-between gap-3 text-[13px] text-v2-muted">
              <span className="flex flex-col">
                <span>Balance: {balanceDisplay ? `${balanceDisplay} ${tokenIn.symbol}` : '—'}</span>
                <TokenIdentity token={tokenIn} chainId={activeChainId} />
              </span>
              {balanceIn && (
                <span className="flex gap-1">
                  <button type="button" className="ts-v2-chip min-h-[44px] px-2 font-v2-mono text-[12px] font-medium uppercase tracking-[1.5px] text-v2-muted hover:text-v2-text" onClick={() => setAmount(formatUnits(balanceIn.value / 2n, balanceIn.decimals))}>
                    50%
                  </button>
                  <button type="button" className="ts-v2-chip min-h-[44px] px-2 font-v2-mono text-[12px] font-medium uppercase tracking-[1.5px] text-v2-muted hover:text-v2-text" onClick={() => setAmount(formatUnits(balanceIn.value, balanceIn.decimals))}>
                    MAX
                  </button>
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-center">
          <Button variant="icon" aria-label="Swap sell and receive tokens" onClick={invert}>
            <span aria-hidden="true" className="text-[18px]">&#8645;</span>
          </Button>
        </div>

        <div>
          <span className="font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted">Receive</span>
          <div className="ts-swap-field">
            <span data-receive="" className="ts-swap-out font-v2-mono text-[28px] text-v2-cream">
              {meta?.best ? <DigitRoller value={outputDisplay} prefix="~" /> : quoting ? <Skeleton height={28} width="70%" /> : <span className="text-v2-dim">0.0</span>}
            </span>
            <TokenButton token={tokenOut} side="receive" />
          </div>
          {showSources && (
            <div className="mt-1 flex items-center justify-between gap-3">
              <SourcesMenu excluded={excludedSources} onToggle={toggleSource} />
              {meta && <span className="text-[12px] text-v2-muted">{meta.all.length} sources queried</span>}
            </div>
          )}
        </div>

        <Toggle
          className="mt-3"
          checked={mevProtected}
          onChange={setMevProtected}
          label={
            <span className="inline-flex items-center gap-2">
              Force MEV Protection
              <Tip
                label="MEV protection info"
                content="Always route through CoW Protocol regardless of price. When off, TeraSwap automatically prefers MEV-protected routes when pricing is competitive."
              />
            </span>
          }
        />

        {mevProtected && !meta && matchedRawMeta && !quoteLoading && (
          <div className="mt-3">
            <Notice tone="amber">No MEV-protected quote available. CoW Protocol may be temporarily unavailable. Try disabling Force MEV Protection or wait a moment.</Notice>
          </div>
        )}

        {quoteError && (
          <div className="mt-3">
            <Notice tone="red">{quoteError}</Notice>
          </div>
        )}

        {meta && mevExposedBest && !mevHintDismissed && (
          <div className="mt-2 flex items-center gap-2 text-[13px] text-v2-muted">
            <span>CoW Protocol available for MEV protection.</span>
            <Button variant="text" onClick={() => setMevProtected(true)}>
              Enable
            </Button>
            <Button variant="icon" onClick={dismissMevHint} aria-label="Dismiss MEV protection hint">
              <span aria-hidden="true">×</span>
            </Button>
          </div>
        )}
      </Surface>

      <Surface edge="top" className="ts-swap-quote" aria-busy={quoting || undefined}>
        {view && meta && tokenIn && tokenOut ? (
          <QuotePanel
            view={view}
            symbolIn={tokenIn.symbol}
            symbolOut={tokenOut.symbol}
            countdown={countdown}
            onRefresh={refreshQuote}
            refreshing={quoteLoading}
            priceCheck={pairCheck}
            approvalPlan={approvalPlan}
            onEditSlippage={() => {}}
            smartMevApplied={smartMevApplied}
            gasless={meta.gasless}
            lowConfidence={!!meta.lowConfidence}
            sourceCount={meta.all.length}
            onUseGasless={() => setMevProtected(true)}
          />
        ) : (
          <div aria-hidden="true" data-skeleton={quoting ? 'quoting' : 'idle'} className="ts-swap-skeleton">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="ts-swap-skeleton-row">
                <Skeleton height={10} width={i % 2 ? 84 : 100} />
                <Skeleton height={10} width={i % 3 ? 100 : 124} />
              </div>
            ))}
          </div>
        )}
      </Surface>

      <div className="ts-swap-cta">
        <Button variant="primary" className="w-full" disabled={cta.disabled} data-cta={cta.kind} data-b5-stub="">
          {cta.label}
        </Button>
        {meta?.gasless?.recommended && meta.best.source !== 'cowswap' && (
          <Button
            variant="text"
            className="mt-2 w-full"
            aria-label="Gasless route available — review the recommendation"
            onClick={() => document.getElementById('quote-breakdown')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            Gasless option available{meta.gasless.gasSavingsUsd >= 0.5 ? ` — save ~${fmtUsd(meta.gasless.gasSavingsUsd)}` : ''}
          </Button>
        )}
      </div>
    </section>
  )
}
