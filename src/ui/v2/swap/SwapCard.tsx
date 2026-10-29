'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useBalance, useSwitchChain } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatUnits, parseUnits } from 'viem'
import DigitRoller from '@/components/DigitRoller'
import ChainIcon from '@/components/icons/ChainIcon'
import { calculateAutoSlippage } from '@/components/SlippageModal'
import { useQuote } from '@/hooks/useQuote'
import { useQuoteChainId } from '@/hooks/useChainId'
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice'
import { useEthGasCost } from '@/hooks/useEthGasCost'
import { useApproval } from '@/hooks/useApproval'
import { useSwapPriceTier } from '@/hooks/useSwapPriceTier'
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
import { playQuoteReceived, playTouchMP3 } from '@/lib/sounds'
import { CHAIN_ID } from '@/lib/constants'
import { isVerifiedToken } from '@/lib/chains/tokens'
import { safeBigInt } from '@/lib/utils'
import { Button, Input, Skeleton, Surface, Toggle } from '../primitives'
import { CtaButton } from './CtaButton'
import { shortAddress } from '../shell/format-address'
import './swap.css'
import { ctaFor } from './cta'
import { buildQuoteView, quoteIsForAmount } from './quote-model'
import { QuotePanel, Notice } from './QuotePanel'
import { TierNotice } from './TierNotice'
import { SourcesMenu } from './SourcesMenu'
import { Tip } from './Tip'
import { TokenButton } from './TokenButton'
import { SlippageSheet } from '../modals/SlippageSheet'
import { TokenSheet } from '../modals/TokenSheet'
import { Permit2Sheet } from '../modals/Permit2Sheet'
import { ReviewSheet } from '../modals/ReviewSheet'
import { ConsentSheet } from '../modals/ConsentSheet'
import { CowOrderReviewSheet } from '../modals/CowOrderReviewSheet'
import { SplitReviewSheet } from '../modals/SplitReviewSheet'
import { buildReviewModel, reviewOpen, unpricedConsentValues, withFrozenSwap, type ReviewModel } from '../modals/review-model'
import { useV2Toast } from '../shell/toasts'
import { GateNotices } from './lifecycle/GateNotices'
import { SplitRoutePanel } from './lifecycle/SplitRoutePanel'
import { ApprovalStep } from './lifecycle/ApprovalStep'
import { ExecutionPanel } from './lifecycle/ExecutionPanel'
import { useSwapGates } from './lifecycle/use-swap-gates'
import { useSwapLifecycle } from './lifecycle/use-swap-lifecycle'
import { buildTimeline, confirmButtonState, SIGNING_STATUSES } from './lifecycle/lifecycle-view'

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
 * [ADR-025] The Swap tab: round7 frames 20 / 21a / 21b (B3), the review / consent / Permit2 sheets (B4) and — B5 — the wallet
 * lifecycle. It reuses v1's hooks UNCHANGED: the same quote, oracle, gas and approval reads SwapBox makes, and the same
 * `useSwap` / `useSplitSwap` / `useApproval` calls (see `lifecycle/use-swap-lifecycle.ts`). The card never computes an amount,
 * a minimum output or calldata: it hands the hooks the quote and renders what they freeze.
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
  // v1's SwapBox state, same names and defaults: slippage is Auto until the user picks otherwise (frame 22).
  const [manualSlippage, setManualSlippage] = useState(DEFAULT_SLIPPAGE)
  const [isAutoSlippage, setIsAutoSlippage] = useState(true)
  const [showSlippage, setShowSlippage] = useState(false)
  const [tokenPicker, setTokenPicker] = useState<'sell' | 'receive' | null>(null)
  const [reviewRequested, setReviewRequested] = useState(false)
  // The review model as it stood when Confirm was pressed: the sheet keeps describing what was confirmed while the quote polls on.
  const [confirmedModel, setConfirmedModel] = useState<ReviewModel | null>(null)
  const { toast } = useV2Toast()
  const { openConnectModal } = useConnectModal()
  const { switchChain } = useSwitchChain()

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
  // v1 re-runs calculateAutoSlippage in an effect whenever the pair/chain changes while Auto is on; here Auto is derived, so there
  // is never a render where the pair has changed and the value has not.
  const autoSlippage = tokenIn && tokenOut ? calculateAutoSlippage(tokenIn.symbol, tokenOut.symbol, activeChainId) : DEFAULT_SLIPPAGE
  const slippage = isAutoSlippage ? autoSlippage : manualSlippage

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
  // v1's one effect on a new best source: play the quote-received blip, and fetch that source's spender. Keyed on the picked
  // quote (v1's `meta`, which survives an amount change), NOT on the amount-gated `meta` above: a re-quote that lands the same
  // winner is not a new arrival (no second blip), exactly as in SwapBox.
  const pickedSource = pickedMeta?.best.source
  const spenderKey = pickedSource ? `${pickedSource}:${activeChainId}` : null
  useEffect(() => {
    if (!spenderKey || !pickedSource) return
    playQuoteReceived()
    const controller = new AbortController()
    fetch(`/api/spender?source=${pickedSource}${activeChainId !== 1 ? `&chainId=${activeChainId}` : ''}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (!data.spender) return
        // [FULL-H-02] a compromised /api/spender must never become a trusted spender
        const trusted = isTrustedSpender(data.spender, activeChainId)
        if (!trusted) {
          console.error('[Security] Untrusted spender address from /api/spender:', data.spender)
          toast({ type: 'error', title: 'Swap unavailable', description: 'Spender validation failed. Please try again or choose another route.' })
        }
        setSpenderAnswer({ key: spenderKey, spender: trusted ? (data.spender as `0x${string}`) : undefined })
      })
      .catch(() => {})
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spenderKey is (source, chain); `meta` itself changes every poll
  }, [spenderKey])
  // An answer only counts for the (source, chain) it was fetched for — the "clear when there is no quote" of v1, derived.
  const spender = spenderAnswer && spenderAnswer.key === spenderKey ? spenderAnswer.spender : undefined
  const approval = useApproval(tokenIn, amountIn, spender)
  const { plan: approvalPlan, needsPermit2Education, confirmPermit2Education, cancelPermit2Education } = approval

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
  const { estimate: gasEstimate, ethPrice: ethUsdPrice } = useEthGasCost()
  // [feat/swap-price-tiers D1] The SERVER's tier for the pair; null = unknown → no notice (the client never guesses).
  const { data: priceTier } = useSwapPriceTier(activeChainId, tokenIn?.address, tokenOut?.address)

  const hasAmount = !!amountIn && Number(amountIn) > 0
  const quoting = hasAmount && !meta && (quoteLoading || (!!pickedMeta && !quoteCurrent))
  const chainActive = isChainActive(activeChainId) // [P223] swaps are disabled on a coming-soon chain
  // v1's `priceCheckStale`: the amount changed and no quote for it has landed — the gate banners wait so they never flash on old data.
  const priceCheckStale = hasAmount && !meta
  const gates = useSwapGates({
    tokenIn,
    tokenOut,
    amountIn,
    meta,
    quoteDecimalsOut,
    activeChainId,
    pairCheck,
    tokenInChainlinkPrice: priceCheck.chainlinkPrice,
    tokenOutChainlinkPrice: tokenOutPriceCheck.chainlinkPrice,
    priceTier,
  })
  const unpricedPair = priceTier?.tier === 'unpriced'
  const lc = useSwapLifecycle({
    tokenIn,
    tokenOut,
    amountIn,
    slippage,
    meta,
    activeChainId,
    isChainOkForQuote,
    chainActive,
    unpricedPair,
    gates,
    approval,
    tokenOutUsdPrice: tokenOutPriceCheck.chainlinkPrice,
  })

  // v1 resets both swap hooks and drops any review whenever the trade changes under them (typed amount, 50% / MAX, ⇅, a token pick), and
  // the hooks reset themselves on a chain / account switch. One key covers all of them, so a sheet opened for one trade can never
  // confirm another: the review closes (v1's behaviour — no notice) and any state a hook holds for the old trade is reset.
  const tradeKey = `${activeChainId}:${tokenIn?.address ?? ''}:${tokenOut?.address ?? ''}:${amountIn}`
  const [prevTradeKey, setPrevTradeKey] = useState(tradeKey)
  if (tradeKey !== prevTradeKey) {
    setPrevTradeKey(tradeKey)
    setReviewRequested(false)
    setConfirmedModel(null)
  }
  const resetAll = lc.resetAll
  useEffect(() => {
    resetAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the trade alone: `resetAll` is a new function every render
  }, [tradeKey])

  // v1 toasts a quote error once per distinct message (the useQuote poll re-raises the same string every cycle); dedupKey replaces.
  const lastQuoteError = useRef<string | null>(null)
  useEffect(() => {
    if (!quoteError) {
      lastQuoteError.current = null
      return
    }
    if (quoteError === lastQuoteError.current) return
    lastQuoteError.current = quoteError
    toast({ type: 'warning', title: 'Quote unavailable', description: quoteError, duration: 6000, dedupKey: 'quote-error' })
  }, [quoteError, toast])
  // [BUGFIX in v1] parseUnits throws on malformed input ("1.2.3") — that is "insufficient", never a crash.
  const hasSufficientBalance =
    !hasAmount ||
    !balanceIn ||
    !tokenIn ||
    (() => {
      try {
        return parseUnits(amountIn, tokenIn.decimals) <= balanceIn.value
      } catch {
        return false
      }
    })()
  const cta = ctaFor({
    isConnected,
    isCorrectChain,
    targetChainName: (() => {
      try {
        return getChainConfig(CHAIN_ID).name
      } catch {
        return 'Ethereum'
      }
    })(),
    hasAmount,
    hasSufficientBalance,
    quoteLoading: quoting,
    hasQuote: !!meta,
    blockReason: gates.blockReason,
    approvalStatus: approval.status,
    approvalReady: approval.isReady,
    swapStatus: lc.status,
    splitActive: lc.isSplitActive,
  })

  // Cheap and pure; not memoised because useEthGasCost rebuilds `gasEstimate` on every render (v1 passes it straight through too).
  const view =
    meta && tokenIn && tokenOut && hasAmount
      ? buildQuoteView({ meta, tokenIn, tokenOut, amountIn, slippage, chainId: activeChainId, tokenInUsdPrice: priceCheck.chainlinkPrice, tokenOutUsdPrice: tokenOutPriceCheck.chainlinkPrice, gasEstimate, ethUsdPrice })
      : null

  const outputDisplay =
    meta?.best && quoteDecimalsOut !== null
      ? (() => {
          const v = safeBigInt(meta.best.toAmount)
          return v !== null ? fmtToken(v, quoteDecimalsOut) : '—'
        })()
      : '0.0'
  const balanceDisplay = balanceIn ? fmtToken(balanceIn.value, balanceIn.decimals) : null

  // A changed trade resets both swap hooks (see `tradeKey`) — without it a stale `success` from a smaller amount survives into the
  // next cycle (v1: BUG-SWAP-APPROVE-STALE-SUCCESS).
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
    lc.resetAll()
  }

  const showSources = shouldShowSourceToggle(meta?.all.length ?? null, excludedSources.size)

  // ── B5: which sheet the hooks' state calls for ──
  const liveModel = view && meta && tokenIn && tokenOut ? buildReviewModel({ view, meta, tokenIn, tokenOut, amountIn, slippage, tier: priceTier }) : null
  const baseModel = confirmedModel ?? liveModel
  const frozenSwap = lc.swap.status === 'confirming' ? lc.swap.pendingSwap : null
  const sheetModel = baseModel && frozenSwap ? withFrozenSwap(baseModel, frozenSwap, AGGREGATOR_META[frozenSwap.source]?.label ?? frozenSwap.source) : baseModel
  const swapSt = lc.swap.status
  // The single-route review is on screen from the CTA until the signature is requested; a split has no such review (v1 goes straight to the plan).
  const singleReviewOpen =
    !lc.isSplitActive && reviewOpen({ requested: reviewRequested, ackRequired: lc.swap.unpricedAckRequired }) && !SIGNING_STATUSES.has(swapSt) && swapSt !== 'success' && swapSt !== 'cow_awaiting_review'
  const splitConsentOpen = lc.isSplitActive && (lc.consentRequested || lc.split.unpricedAckRequired)
  const splitReviewOpen = lc.isSplitActive && lc.split.status === 'awaiting-review' && !!address
  const cowReviewOpen = lc.swap.status === 'cow_awaiting_review' && !!lc.swap.pendingCowOrder && !!address
  const anySheetOpen = showSlippage || tokenPicker !== null || needsPermit2Education || singleReviewOpen || splitConsentOpen || splitReviewOpen || cowReviewOpen
  const confirmBtn = confirmButtonState({ approvalStatus: approval.status, approvalReady: approval.isReady, swapStatus: swapSt })

  // The Execution column is up from the first hook step until the visitor starts over (New swap, or any change to the trade).
  const executionActive = lc.status !== 'idle'
  const explorerUrl = (() => {
    try {
      return getChainConfig(activeChainId).blockExplorer
    } catch {
      return getChainConfig(1).blockExplorer
    }
  })()
  function onNewSwap() {
    lc.resetAll()
    setConfirmedModel(null)
    setReviewRequested(false)
    setDisplayAmountIn('')
  }

  function onWrongNetwork() {
    playTouchMP3()
    switchChain({ chainId: CHAIN_ID }) // v1's SwapButton: the default chain, whatever the label's `Switch to {chain}` names
  }

  async function onReviewConfirm(c: { unpricedAck: boolean }) {
    playTouchMP3()
    if (frozenSwap) {
      lc.swap.confirmSwap() // v1: <TransactionPreview onConfirm={confirmSwap}>
      return
    }
    // The first press freezes the sheet (it keeps describing what was confirmed while the quote polls on during an approval).
    if (liveModel && !confirmedModel) setConfirmedModel(liveModel)
    // [A69 M-1] …and the press that actually executes re-freezes it from the quote it hands the hook, so the sheet, the hook's arguments and the
    // success summary all describe one quote. v1 freezes at `execute` too (useSwap.ts:733), not at the click that only approves.
    await lc.confirm(c, () => {
      if (liveModel) setConfirmedModel(liveModel)
    })
  }
  function onReviewCancel() {
    setReviewRequested(false)
    setConfirmedModel(null)
    lc.cancel()
  }
  function onCta() {
    playTouchMP3() // v1: SwapButton plays the touch sound on every click
    if (cta.kind === 'connect') {
      openConnectModal?.()
      return
    }
    if (lc.isSplitActive && (cta.kind === 'split-swap' || cta.kind === 'retry')) {
      void lc.confirm() // v1's Swap click on a split: straight to the plan
      return
    }
    if (cta.kind === 'review' || cta.kind === 'retry') {
      if (lc.swap.status === 'error') lc.resetAll() // v1 re-runs execute() from the error state, which clears it
      setConfirmedModel(null)
      setReviewRequested(true)
    }
  }

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
            <TokenButton token={tokenIn} side="sell" onOpen={() => setTokenPicker('sell')} />
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
            <TokenButton token={tokenOut} side="receive" onOpen={() => setTokenPicker('receive')} />
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
        {executionActive && tokenIn && tokenOut ? (
          <ExecutionPanel
            steps={buildTimeline({ route: lc.route, status: lc.status, lastActive: lc.lastActive })}
            phase={lc.status === 'success' ? 'success' : lc.status === 'error' ? 'failure' : 'pending'}
            symbolIn={tokenIn.symbol}
            symbolOut={tokenOut.symbol}
            amountIn={amountIn}
            summary={lc.success}
            txHash={lc.swap.txHash}
            explorerUrl={explorerUrl}
            error={lc.error}
            failureTitle={lc.isSplitActive ? (lc.split.status === 'partial' ? 'Split swap partially complete' : 'Split swap failed') : 'Swap failed'}
            cowPending={lc.swap.status === 'cow_pending'}
            legs={lc.isSplitActive ? { rows: lc.split.legs, completed: lc.split.completedLegs, total: lc.split.totalLegs } : undefined}
            simulation={{ passed: lc.swap.simulationPassed, skipped: lc.swap.simulationSkipped, swapStatus: lc.swap.status }}
            fallback={lc.swap.fallbackNotice}
            sheetOpen={anySheetOpen}
            onNewSwap={onNewSwap}
          />
        ) : view && meta && tokenIn && tokenOut ? (
          <QuotePanel
            view={view}
            symbolIn={tokenIn.symbol}
            symbolOut={tokenOut.symbol}
            countdown={countdown}
            onRefresh={refreshQuote}
            refreshing={quoteLoading}
            priceCheck={pairCheck}
            approvalPlan={approvalPlan}
            onEditSlippage={() => setShowSlippage(true)}
            smartMevApplied={smartMevApplied}
            gasless={meta.gasless}
            lowConfidence={!!meta.lowConfidence}
            sourceCount={meta.all.length}
            onUseGasless={() => setMevProtected(true)}
            tierNotice={<TierNotice tier={priceTier} />}
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

      {/* B5: v1's price-gate banners (and the consent checkboxes that clear the recoverable ones), right above the button. */}
      <GateNotices gates={gates} pairCheck={pairCheck} hasQuote={!!meta} hasAmount={hasAmount} stale={priceCheckStale} priceGuard={{ blocked: lc.swap.priceGuardBlocked, deviation: lc.swap.priceGuardDeviation }} />
      {lc.splitRoute.splitResult?.bestSplit.isSplit && tokenOut && (
        <SplitRoutePanel splitResult={lc.splitRoute.splitResult} tokenOut={tokenOut} useSplit={lc.splitRoute.useSplit} onToggle={lc.splitRoute.toggleSplit} analyzing={lc.splitRoute.analyzing} />
      )}

      <div className="ts-swap-cta">
        <CtaButton cta={cta} onClick={cta.kind === 'wrong-network' ? onWrongNetwork : onCta} />
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

      {showSlippage && (
        <SlippageSheet
          value={slippage}
          onChange={setManualSlippage}
          onClose={() => setShowSlippage(false)}
          isAuto={isAutoSlippage}
          onAutoChange={setIsAutoSlippage}
          tokenInSymbol={tokenIn?.symbol}
          tokenOutSymbol={tokenOut?.symbol}
          chainId={activeChainId}
        />
      )}
      {needsPermit2Education && (
        <Permit2Sheet amount={amountIn} tokenSymbol={tokenIn?.symbol} onConfirm={confirmPermit2Education} onCancel={cancelPermit2Education} />
      )}
      {singleReviewOpen && sheetModel && tokenIn && tokenOut && (
        <ReviewSheet
          model={sheetModel}
          pending={
            frozenSwap && address
              ? {
                  calldata: frozenSwap.routerCalldata,
                  routerAddress: frozenSwap.routerAddress,
                  source: frozenSwap.source,
                  userAddress: address,
                  routeViaFeeCollector: frozenSwap.routeViaFeeCollector,
                  minimumOutput: frozenSwap.minimumOutput,
                  decimalsOut: frozenSwap.tokenOut.decimals,
                  tokenOutAddress: frozenSwap.tokenOut.address,
                }
              : undefined
          }
          ackRequired={lc.ackRequired}
          confirmLabel={confirmBtn.label}
          confirmBusy={confirmBtn.disabled}
          confirmTone={confirmBtn.tone}
          step={
            <>
              {lc.error && lc.swap.status === 'error' && (
                <div className="mt-4">
                  <Notice tone="red" testId="review-error">
                    {lc.error}
                  </Notice>
                </div>
              )}
              <ApprovalStep approvalStatus={approval.status} approvalReady={approval.isReady} swapStatus={lc.swap.status} showNote={hasAmount && !!meta && !quoting} />
            </>
          }
          onConfirm={onReviewConfirm}
          onCancel={onReviewCancel}
        />
      )}
      {splitConsentOpen && meta && tokenIn && tokenOut && (
        <ConsentSheet values={unpricedConsentValues(meta, tokenIn, tokenOut, slippage, quoteDecimalsOut ?? tokenOut.decimals)} onContinue={() => void lc.confirm({ unpricedAck: true })} onCancel={lc.cancel} />
      )}
      {splitReviewOpen && address && (
        <SplitReviewSheet plannedLegs={lc.split.plannedLegs} tokenIn={tokenIn} tokenOut={tokenOut} userAddress={address} onConfirm={() => void lc.split.confirmPlan()} onCancel={lc.cancel} />
      )}
      {cowReviewOpen && lc.swap.pendingCowOrder && (
        <CowOrderReviewSheet order={lc.swap.pendingCowOrder} onConfirm={() => void lc.swap.confirmCowOrder()} onCancel={lc.cancel} />
      )}
      {tokenPicker && (
        <TokenSheet
          disabledAddress={(tokenPicker === 'sell' ? tokenOut : tokenIn)?.address}
          onSelect={(t) => (tokenPicker === 'sell' ? setSelectedIn(t) : setSelectedOut(t))}
          onClose={() => setTokenPicker(null)}
        />
      )}
    </section>
  )
}
