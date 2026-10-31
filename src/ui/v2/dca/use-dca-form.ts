'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits, parseUnits } from 'viem'
import { useTokenBalances } from '@/hooks/useTokenBalances'
import { useTokenBalance } from '@/hooks/useTokenBalance'
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice'
import { useDepegCheck } from '@/hooks/useDepegCheck'
import {
  DCA_INTERVAL_PRESETS,
  DCA_TOTAL_PRESETS,
  EXPIRY_PRESETS,
  getDefaultRouter,
  NO_ROUTER_FOR_CHAIN_REASON,
  MIN_ORDER_AMOUNT,
  dcaScheduleFitsExpiry,
  clampCustomBuys,
  clampCustomIntervalNumber,
  customIntervalSeconds,
  deriveCustomExpirySeconds,
  getDcaMinChunkUsd,
  applyDcaMinChunkGuard,
  checkMinOutEconomicFloor,
  getOrderExecutorV3,
  DEFAULT_MAX_SLIPPAGE_BPS,
  deriveSigningMinAmountOut,
  type CreateOrderConfig,
  type DcaCustomIntervalUnit,
} from '@/lib/order-engine'
import { checkRoute } from '@/lib/order-engine/check-route'
import { affectedSymbols, fetchPairFloorInfo, type PairFloorInfo } from '@/components/dca/pair-floor-info'
import { isNativeETH, type Token } from '@/lib/tokens'
import { getWrappedNative, getChainConfig } from '@/lib/chains/registry'
import { findChainToken, resolveSignableToken, getCanonicalUsdc } from '@/lib/chains/tokens'
import { fetchDefiLlamaPriceViaApi } from '@/lib/defillama-client'
import { quickFillRaw, perChunkRaw, formatMinBuyMessage } from '@/lib/dca-quick-fill'
import { fmtFixed } from '@/lib/format'
import { NATIVE_ETH, DEPEG_CONSENT_TOLERANCE } from '@/lib/constants'
import { playClick, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { buildDcaDraft, consentTier, dcaCtaFor, evaluateDcaOracleGate, perBuyText, totalDurationText, type WeakerTier } from './dca-model'

/** The chain's wrapped native as a rich Token — the DCA spend default (never native ETH). Same helper as v1's `wethFor`. */
function wethFor(chainId: number): Token | null {
  return findChainToken(getWrappedNative(chainId), chainId)
}

function defaultBuy(chainId: number): Token | null {
  const usdc = getCanonicalUsdc(chainId)
  const weth = wethFor(chainId)
  // v1: the default buy must never equal the default sell — fail closed to an empty selector.
  if (usdc && weth && usdc.address.toLowerCase() === weth.address.toLowerCase()) return null
  return usdc
}

export interface PreparedReview {
  /** The draft v1 would hand `createOrder`, WITHOUT the floor ack (the sheet adds it once the consent box is ticked). */
  draft: CreateOrderConfig
  info: PairFloorInfo
  /** The legs the consent copy names (affectedSymbols). */
  symbols: string[]
  minAmountOut: string
}

export type PrepareResult = { ok: true; review: PreparedReview } | { ok: false }

export interface PrepareOptions {
  /**
   * A tier the user just acknowledged — v1's `handleCreate(ack)` (DCAPanel.tsx:1209 via the consent dialog's confirm): the server is
   * NOT asked again, the draft carries `floorAck = { tier: ack, acknowledgedAt: now }`. Never a stored ack: the caller passes the tier
   * whose box is ticked on the sheet in front of the user right now.
   */
  ack?: WeakerTier
  /**
   * v1 starts the waiting loop at the top of every `handleCreate` (:825). The review's Create on the on-chain tier is the one press
   * where the loop the form press started is still running and v1 starts nothing new. Default true.
   */
  startSound?: boolean
}

/** `form.prepare` — the lifecycle's Create and Retry call it afresh on every press. */
export type PrepareFn = (opts?: PrepareOptions) => Promise<PrepareResult>

/**
 * [ADR-025] The DCA form's state: v1's `CreateDCAForm` state and derivations, one for one, over v1's own hooks (balances, Chainlink,
 * depeg, floor-tier ask) and lib (presets, schedule-fit, dust guard, min-output derivation). `prepare()` is v1's `handleCreate` up to
 * the point where it would hand the config to `createOrder`: same guards, same order, same sounds — the review's Create (B6b,
 * `use-dca-lifecycle.ts`) then makes that very call.
 */
export function useDcaForm(chainId: number, paused: boolean) {
  const { address: _address, isConnected, chain: walletChain } = useAccount()

  const routeCheckSeq = useRef(0)
  const [tokenIn, setTokenInState] = useState<Token | null>(() => wethFor(chainId))
  const [buySelection, setBuySelectionState] = useState<Token | null>(() => defaultBuy(chainId))
  // A pair change invalidates an in-flight route check (v1: an effect bumps the same counter).
  const setTokenIn = (t: Token | null) => { routeCheckSeq.current++; setTokenInState(t) }
  const setBuySelection = (t: Token | null) => { routeCheckSeq.current++; setBuySelectionState(t) }
  const tokenOut = useMemo(() => resolveSignableToken(buySelection, chainId), [buySelection, chainId])

  // A token selection never outlives the chain it was made on (v1, during render).
  const [selectionChainId, setSelectionChainId] = useState(chainId)
  if (selectionChainId !== chainId) {
    setSelectionChainId(chainId)
    setTokenInState(wethFor(chainId))
    setBuySelectionState(null)
  }

  const { balances } = useTokenBalances()
  const hasNativeOnly = useMemo(() => {
    const weth = wethFor(chainId)
    const wethKey = weth?.address.toLowerCase()
    const nativeBal = balances.get(NATIVE_ETH.toLowerCase())?.raw ?? 0n
    const wethBal = wethKey ? (balances.get(wethKey)?.raw ?? 0n) : 0n
    return nativeBal > 0n && wethBal === 0n
  }, [balances, chainId])
  const mapEntry = useMemo(() => {
    const key = tokenIn && !isNativeETH(tokenIn) ? tokenIn.address.toLowerCase() : undefined
    return key ? balances.get(key) : undefined
  }, [balances, tokenIn])
  const directSpend = useTokenBalance(tokenIn, chainId, { enabled: isConnected && !!tokenIn && !isNativeETH(tokenIn) && !mapEntry })
  const spendRaw = mapEntry?.raw ?? directSpend.raw ?? 0n
  const spendFormatted = mapEntry?.formatted ?? directSpend.formatted
  const hasSpendBalance = !!mapEntry || directSpend.hasValue

  const [totalDisplay, setTotalDisplay] = useState('')
  const [partsIdx, setPartsIdx] = useState(2) // 10 buys
  const [intervalIdx, setIntervalIdx] = useState(4) // 1d
  const [expiryIdx, setExpiryIdx] = useState(3) // 30d
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [slippage, setSlippage] = useState('0.5')
  const [customMode, setCustomMode] = useState(false)
  const [customBuysRaw, setCustomBuysRaw] = useState(10)
  const [customIntervalNumRaw, setCustomIntervalNumRaw] = useState(1)
  const [customIntervalUnit, setCustomIntervalUnit] = useState<DcaCustomIntervalUnit>('days')
  const customBuysClamped = clampCustomBuys(customBuysRaw)
  const customIntervalNumClamped = clampCustomIntervalNumber(customIntervalNumRaw)
  const customInterval = {
    label: `${customIntervalNumClamped}${customIntervalUnit === 'hours' ? 'h' : 'd'}`,
    seconds: customIntervalSeconds(customIntervalNumRaw, customIntervalUnit),
  }

  const selectionKey = `${chainId}:${tokenIn?.address ?? ''}:${tokenOut?.address ?? ''}`
  // Keyed to the selection it was earned on, so a changed pair clears it with no reset effect.
  const [routeBlockFor, setRouteBlockFor] = useState<{ key: string; reason: string } | null>(null)
  const routeBlock = routeBlockFor?.key === selectionKey ? routeBlockFor.reason : null
  const setRouteBlock = (reason: string | null) => setRouteBlockFor(reason === null ? null : { key: selectionKey, reason })
  const [checkingRoute, setCheckingRoute] = useState(false)
  const hasImported = tokenIn?.category === 'Imported' || tokenOut?.category === 'Imported'
  const [submitBlockFor, setSubmitBlockFor] = useState<{ key: string; reason: string } | null>(null)
  const submitBlock = submitBlockFor?.key === selectionKey ? submitBlockFor.reason : null

  const v3Enabled = getOrderExecutorV3(chainId) !== null
  const [pairFloorFor, setPairFloorFor] = useState<{ key: string; info: PairFloorInfo } | null>(null)
  const pairFloor = pairFloorFor?.key === selectionKey ? pairFloorFor.info : null
  useEffect(() => {
    if (!v3Enabled || !tokenIn || !tokenOut) return
    const ctl = new AbortController()
    void fetchPairFloorInfo({ chainId, tokenIn: tokenIn.address, tokenOut: tokenOut.address, signal: ctl.signal }).then((info) => {
      if (!ctl.signal.aborted) setPairFloorFor({ key: selectionKey, info })
    })
    return () => ctl.abort()
  }, [v3Enabled, chainId, tokenIn, tokenOut, selectionKey])
  const chainDisplayName = (() => {
    try {
      return getChainConfig(chainId).name
    } catch {
      return 'this chain'
    }
  })()
  const [maxSlippageBps, setMaxSlippageBps] = useState(DEFAULT_MAX_SLIPPAGE_BPS)

  const oracleSpend = useChainlinkPrice(tokenIn?.address, null)
  const oracleBuy = useChainlinkPrice(tokenOut?.address, null)
  const chainlinkPriceIn = oracleSpend.chainlinkPrice
  const chainlinkPriceOut = oracleBuy.chainlinkPrice
  const oracleGate = evaluateDcaOracleGate(oracleSpend, oracleBuy)
  const oracleBlocked = v3Enabled && oracleGate.blocked
  const oracleFallbackAllowed = !oracleBlocked

  // The DefiLlama fallback answers, each keyed to the token and chain it was fetched for; the value in use is derived, so a blocked
  // oracle, a Chainlink answer or a changed pair drops it with no reset effect (v1 clears the same cases inside its effect).
  const [llamaIn, setLlamaIn] = useState<{ key: string; price: number | null } | null>(null)
  const [llamaOut, setLlamaOut] = useState<{ key: string; price: number | null } | null>(null)
  const llamaKeyIn = `${chainId}:${tokenIn?.address ?? ''}`
  const llamaKeyOut = `${chainId}:${tokenOut?.address ?? ''}`
  useEffect(() => {
    if (!v3Enabled || !oracleFallbackAllowed) return
    let cancelled = false
    if (chainlinkPriceIn == null && tokenIn) {
      fetchDefiLlamaPriceViaApi(tokenIn.address, chainId).then((p) => { if (!cancelled) setLlamaIn({ key: llamaKeyIn, price: p?.price ?? null }) }).catch(() => { if (!cancelled) setLlamaIn({ key: llamaKeyIn, price: null }) })
    }
    if (chainlinkPriceOut == null && tokenOut) {
      fetchDefiLlamaPriceViaApi(tokenOut.address, chainId).then((p) => { if (!cancelled) setLlamaOut({ key: llamaKeyOut, price: p?.price ?? null }) }).catch(() => { if (!cancelled) setLlamaOut({ key: llamaKeyOut, price: null }) })
    }
    return () => {
      cancelled = true
    }
  }, [v3Enabled, oracleFallbackAllowed, tokenIn, tokenOut, chainlinkPriceIn, chainlinkPriceOut, chainId, llamaKeyIn, llamaKeyOut])
  const llamaPriceIn = v3Enabled && oracleFallbackAllowed && chainlinkPriceIn == null && llamaIn?.key === llamaKeyIn ? llamaIn.price : null
  const llamaPriceOut = v3Enabled && oracleFallbackAllowed && chainlinkPriceOut == null && llamaOut?.key === llamaKeyOut ? llamaOut.price : null
  const livePriceIn = chainlinkPriceIn ?? llamaPriceIn
  const livePriceOut = chainlinkPriceOut ?? llamaPriceOut

  const liveAmountInRaw = useMemo(() => {
    if (!v3Enabled || !tokenIn || !totalDisplay) return null
    try { return parseUnits(totalDisplay, tokenIn.decimals) } catch { return null }
  }, [v3Enabled, tokenIn, totalDisplay])
  const signingMin = useMemo(() => {
    if (!v3Enabled || oracleBlocked || !tokenIn || !tokenOut || liveAmountInRaw == null || liveAmountInRaw <= 0n) return null
    return deriveSigningMinAmountOut({
      amountIn: liveAmountInRaw, srcDecimals: tokenIn.decimals, dstDecimals: tokenOut.decimals, maxSlippageBps,
      chainlinkPriceIn, chainlinkPriceOut, defiLlamaPriceIn: llamaPriceIn, defiLlamaPriceOut: llamaPriceOut,
    })
  }, [v3Enabled, oracleBlocked, tokenIn, tokenOut, liveAmountInRaw, maxSlippageBps, chainlinkPriceIn, chainlinkPriceOut, llamaPriceIn, llamaPriceOut])

  const totalUsd = useMemo(() => {
    if (!totalDisplay || !tokenIn || livePriceIn == null) return null
    try {
      const human = Number(formatUnits(parseUnits(totalDisplay, tokenIn.decimals), tokenIn.decimals))
      return Number.isFinite(human) ? human * livePriceIn : null
    } catch {
      return null
    }
  }, [totalDisplay, tokenIn, livePriceIn])

  const depegCheck = useDepegCheck(tokenIn?.address, tokenOut?.address)
  // Consent (like SwapBox's) is per chain: a new chain is a new trade — keyed, so a switch revokes it with no reset effect.
  const [acceptedDepegFor, setAcceptedDepegFor] = useState<{ chainId: number; divergence: number } | null>(null)
  const acceptedDepeg = acceptedDepegFor?.chainId === chainId ? acceptedDepegFor.divergence : null
  const setAcceptedDepeg = (divergence: number | null) => setAcceptedDepegFor(divergence === null ? null : { chainId, divergence })
  const depegConsentNeeded = depegCheck.mode === 'consent'
  const depegAccepted = acceptedDepeg != null && depegCheck.divergence <= acceptedDepeg + DEPEG_CONSENT_TOLERANCE
  const depegConsentBlocking = depegConsentNeeded && !depegAccepted
  const depegHardBlocked = depegCheck.mode === 'block'
  const depegUnverified = depegCheck.mode === 'unverified'
  const depegBlocking = depegHardBlocked || depegConsentBlocking || depegUnverified

  const dcaMinChunkUsd = useMemo(() => getDcaMinChunkUsd(), [])
  const minChunkGuard = useMemo(
    () => (customMode ? applyDcaMinChunkGuard({ totalUsd, requestedBuys: customBuysClamped, minChunkUsd: dcaMinChunkUsd }) : { buys: customBuysClamped, warning: null as string | null, blocked: false }),
    [customMode, totalUsd, customBuysClamped, dcaMinChunkUsd],
  )
  const minChunkUncheckable = customMode && v3Enabled && !oracleBlocked && !!tokenIn && !!tokenOut && Number(totalDisplay) > 0 && livePriceIn == null

  const parts = customMode ? minChunkGuard.buys : DCA_TOTAL_PRESETS[partsIdx]
  const interval = customMode ? customInterval : DCA_INTERVAL_PRESETS[intervalIdx]
  const expiry = useMemo(() => {
    if (!customMode) return EXPIRY_PRESETS[expiryIdx]
    const seconds = deriveCustomExpirySeconds({ intervalSeconds: interval.seconds, buys: parts })
    const label = seconds < 86_400 ? `${Math.round(seconds / 3600)}h` : `${fmtFixed(seconds / 86_400, 1)}d`
    return { label, seconds }
  }, [customMode, expiryIdx, interval.seconds, parts])

  const balanceDisplay = useMemo(() => {
    if (!isConnected || !hasSpendBalance) return '—'
    return `${spendFormatted ?? ''} ${tokenIn?.symbol ?? ''}`.trim()
  }, [isConnected, hasSpendBalance, spendFormatted, tokenIn])
  const presetsDisabled = !isConnected || spendRaw === 0n
  function fillPct(pct: 25 | 50 | 100) {
    if (!tokenIn || spendRaw === 0n) return
    setTotalDisplay(formatUnits(quickFillRaw(spendRaw, pct), tokenIn.decimals))
  }

  const underMin = useMemo(() => {
    if (!totalDisplay || !tokenIn || !parts) return false
    try { return perChunkRaw(parseUnits(totalDisplay, tokenIn.decimals), parts) < MIN_ORDER_AMOUNT } catch { return false }
  }, [totalDisplay, tokenIn, parts])
  const minBuyMessage = useMemo(() => {
    if (!underMin || !totalDisplay || !tokenIn || !parts) return null
    try {
      return formatMinBuyMessage({ minBuyRaw: MIN_ORDER_AMOUNT, decimals: tokenIn.decimals, symbol: tokenIn.symbol, totalRaw: parseUnits(totalDisplay, tokenIn.decimals), requestedBuys: parts, priceUsd: livePriceIn }).text
    } catch {
      return null
    }
  }, [underMin, totalDisplay, tokenIn, parts, livePriceIn])

  const perPart = useMemo(() => perBuyText(totalDisplay, tokenIn?.decimals, parts), [totalDisplay, parts, tokenIn])
  const totalDuration = useMemo(() => totalDurationText(parts, interval.seconds), [parts, interval])
  const scheduleFit = useMemo(() => dcaScheduleFitsExpiry({ intervalSeconds: interval.seconds, dcaTotal: parts, expirySeconds: expiry.seconds }), [interval, parts, expiry])

  const amountRaw = useMemo(() => {
    if (!tokenIn || !totalDisplay) return null
    try { return parseUnits(totalDisplay, tokenIn.decimals) } catch { return null }
  }, [tokenIn, totalDisplay])
  const insufficient = isConnected && hasSpendBalance && amountRaw != null && amountRaw > spendRaw

  // v1's `canCreate` (isSubmitting is B6b's: nothing is submitted here).
  const canCreate = !!(isConnected && tokenIn && tokenOut && Number(totalDisplay) > 0 && !paused && !checkingRoute && scheduleFit.fits && !minChunkGuard.blocked && !depegBlocking && !oracleBlocked && !submitBlock && (!v3Enabled || !!pairFloor))

  const wrongNetwork = isConnected && !!walletChain && walletChain.id !== chainId
  const cta = dcaCtaFor({
    isConnected, wrongNetwork, targetChainName: chainDisplayName, paused,
    hasTokens: !!tokenIn && !!tokenOut, hasAmount: Number(totalDisplay) > 0, insufficient,
    belowFloor: underMin, checkingRoute, blocked: !canCreate,
  })

  /**
   * v1's `handleCreate` up to `onSubmit(config)`: the same guards in the same order, the same sounds. Resolves `{ ok: false }` where v1
   * returns early (a banner or consent explains why) and `{ ok: true, review }` where v1 would build the config and sign — B6b's cue.
   */
  async function prepare(opts: PrepareOptions = {}): Promise<PrepareResult> {
    const { ack, startSound = true } = opts
    if (!canCreate || !tokenIn || !tokenOut) return { ok: false }
    if (!scheduleFit.fits || minChunkGuard.blocked || depegBlocking || oracleBlocked) return { ok: false }
    setRouteBlock(null)
    setSubmitBlockFor(null)
    const defaultRouter = getDefaultRouter(chainId)
    if (!defaultRouter) {
      setRouteBlock(NO_ROUTER_FOR_CHAIN_REASON)
      return { ok: false }
    }
    if (startSound) startWaitingSound()
    let amountIn: string
    try {
      amountIn = parseUnits(totalDisplay, tokenIn.decimals).toString()
    } catch {
      stopWaitingSound()
      return { ok: false }
    }
    if (hasImported) {
      const seq = ++routeCheckSeq.current
      setCheckingRoute(true)
      let routable = true
      let reason: string | undefined
      try {
        const perChunk = perChunkRaw(BigInt(amountIn), parts)
        const result = await checkRoute({
          src: tokenIn.address, dst: tokenOut.address, amount: (perChunk > 0n ? perChunk : BigInt(amountIn)).toString(),
          srcDecimals: tokenIn.decimals, dstDecimals: tokenOut.decimals, chainId,
        })
        routable = result.routable
        reason = result.reason
      } finally {
        setCheckingRoute(false)
      }
      if (routeCheckSeq.current !== seq) {
        stopWaitingSound()
        return { ok: false }
      }
      if (!routable) {
        stopWaitingSound()
        setRouteBlock(reason ?? 'No swap route found for this pair on this network.')
        return { ok: false }
      }
    }
    // The server is asked afresh (v1 does not trust the preview); its answer is the tier the sheet asks consent for. With an `ack` it is
    // not asked again (v1: "a confirmed ack is the tier the user just accepted") — the server re-classifies on POST and 409s if it differs.
    let info: PairFloorInfo = pairFloor ?? { tier: 'onchain-feed', legs: { in: { registered: null, priced: null }, out: { registered: null, priced: null } }, registeredFeedCount: null, effectiveCap: null }
    if (v3Enabled && !ack) info = await fetchPairFloorInfo({ chainId, tokenIn: tokenIn.address, tokenOut: tokenOut.address })

    let minAmountOut: string
    let maxSlippageBpsForConfig: number | undefined
    if (v3Enabled) {
      const derivation = deriveSigningMinAmountOut({
        amountIn: BigInt(amountIn), srcDecimals: tokenIn.decimals, dstDecimals: tokenOut.decimals, maxSlippageBps,
        chainlinkPriceIn, chainlinkPriceOut, defiLlamaPriceIn: llamaPriceIn, defiLlamaPriceOut: llamaPriceOut,
      })
      minAmountOut = derivation.minAmountOut.toString()
      maxSlippageBpsForConfig = maxSlippageBps
    } else {
      minAmountOut = '1'
    }
    if (v3Enabled) {
      const floorCheck = checkMinOutEconomicFloor({ minAmountOut: BigInt(minAmountOut), tokenOutDecimals: tokenOut.decimals, tokenOutUsdPrice: livePriceOut })
      if (floorCheck.blocked) {
        stopWaitingSound()
        setSubmitBlockFor({ key: selectionKey, reason: floorCheck.reason ?? '' })
        return { ok: false }
      }
    }
    // v1 stops the loop only where it opens the consent dialog (DCAPanel.tsx:895) — the review carries that consent for the weaker
    // tiers, so it stops here for them. On the on-chain tier v1 goes straight to the EIP-712 modal with the loop running (:825 → :993)
    // and so does v2 (B6b): the review's Create hands over to `createOrder` with no new start; the engine's event ends it.
    if (!ack && consentTier(info)) stopWaitingSound()
    const draft = buildDcaDraft({
      tokenIn, tokenOut, amountIn, minAmountOut, maxSlippageBps: maxSlippageBpsForConfig,
      expirySeconds: expiry.seconds, router: defaultRouter.address, priceInUsd: livePriceIn,
      dcaInterval: interval.seconds, dcaTotal: parts,
      ...(v3Enabled && ack ? { floorAck: { tier: ack, acknowledgedAt: new Date().toISOString() } } : {}),
    })
    return { ok: true, review: { draft, info, symbols: affectedSymbols(info, tokenIn.symbol, tokenOut.symbol), minAmountOut } }
  }

  // Every price `prepare()` reads into the draft (the floor derivation's four prices; `priceInUsd` is `livePriceIn`).
  const priceKey = `${chainlinkPriceIn ?? ''}:${chainlinkPriceOut ?? ''}:${llamaPriceIn ?? ''}:${llamaPriceOut ?? ''}`

  return {
    chainId, chainDisplayName, isConnected, v3Enabled, priceKey,
    tokenIn, setTokenIn, tokenOut, buySelection, setBuySelection,
    totalDisplay, setTotalDisplay, balanceDisplay, presetsDisabled, fillPct, hasNativeOnly,
    partsIdx, setPartsIdx, intervalIdx, setIntervalIdx, expiryIdx, setExpiryIdx,
    customMode, setCustomMode, customBuysRaw, setCustomBuysRaw, customIntervalNumRaw, setCustomIntervalNumRaw,
    customIntervalUnit, setCustomIntervalUnit, customInterval,
    showAdvanced, setShowAdvanced, slippage, setSlippage, maxSlippageBps, setMaxSlippageBps, signingMin,
    parts, interval, expiry, perPart, totalDuration, scheduleFit,
    minBuyMessage, minChunkGuard, minChunkUncheckable, dcaMinChunkUsd,
    hasImported, routeBlock, checkingRoute, submitBlock,
    pairFloor, consentTier: consentTier(pairFloor) as WeakerTier | null,
    depegCheck, depegHardBlocked, depegUnverified, depegConsentNeeded, depegAccepted, setAcceptedDepeg,
    oracleBlocked, oracleGate,
    canCreate, cta, insufficient, prepare, playClick,
  }
}

export type DcaForm = ReturnType<typeof useDcaForm>
