'use client'

import { useCallback, useState } from 'react'
import type { PendingOrderReview } from '@/hooks/useOrderEngine'
import type { CreateOrderConfig, OrderEngineEvent } from '@/lib/order-engine'
import { startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { requiredTierFromError, type WeakerTier } from './dca-model'
import type { PreparedReview } from './use-dca-form'

/** The slice of v1's `useOrderEngine()` the create path uses — the ONE instance the card holds, never a second hook. */
export interface DcaEngineSlice {
  createOrder: (config: CreateOrderConfig) => Promise<void>
  pendingOrder: PendingOrderReview | null
  confirmOrder: () => Promise<void>
  clearPendingOrder: () => void
  isSubmitting: boolean
  latestEvent: OrderEngineEvent | null
}

/**
 * idle → review (the B6a sheet, from `prepare()`) → creating (`createOrder` running) → frozen (the engine's `pendingOrder`: the EIP-712
 * review) → signing (`confirmOrder`: wallet signature + POST, the engine's `isSubmitting`) → created | failed (the engine's event).
 */
export type DcaPhase = 'idle' | 'review' | 'creating' | 'frozen' | 'signing' | 'created' | 'failed'

export type DcaOutcome = { kind: 'created'; orderHash: string } | { kind: 'failed'; error: string }

/**
 * [ADR-025 / B6b] The v2 DCA create lifecycle over v1's `useOrderEngine`, called with DCAPanel's own arguments in DCAPanel's own
 * order: consent → `createOrder(config)` (DCAPanel.tsx:993 `await onSubmit(config)`, the hook FREEZES, nothing is signed) → the
 * EIP-712 review (v1's OrderReviewModal) → `confirmOrder()` (OrderReviewModal.tsx:171 `onClick={onConfirm}`: sign + POST) →
 * `order_created` / `order_error`. Cancel = `clearPendingOrder` (OrderReviewModal.tsx:182). The UI never builds a struct, a
 * floor, a nonce or a deadline: it hands the hook the draft `prepare()` built and renders what the hook froze.
 *
 * A 409 from api/orders reaches the UI as an `order_error` whose text names the tier the server requires (`requiredTierFromError`):
 * the review REOPENS for that tier (B6a `reopenTier`) instead of ending in a failure — the next Create carries the stronger ack.
 */
export function useDcaLifecycle(engine: DcaEngineSlice) {
  const [review, setReview] = useState<PreparedReview | null>(null)
  const [conflictTier, setConflictTier] = useState<WeakerTier | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  // A Create / Sign press happened and has not settled: the next order_created / order_error is THIS attempt's.
  const [armed, setArmed] = useState(false)
  // The config `createOrder` was handed — Retry re-sends the identical object (the hook rebuilds nonce and expiry itself).
  const [draft, setDraft] = useState<CreateOrderConfig | null>(null)
  // The frozen review as it was when Sign was pressed: `confirmOrder` consumes the engine's copy at once, the sheet keeps showing it.
  const [signed, setSigned] = useState<PendingOrderReview | null>(null)
  const [outcome, setOutcome] = useState<DcaOutcome | null>(null)

  // The engine's event, consumed while rendering (the B6a pattern — no effect-set): only an armed attempt reads it.
  const [seenEvent, setSeenEvent] = useState(engine.latestEvent)
  if (engine.latestEvent !== seenEvent) {
    setSeenEvent(engine.latestEvent)
    const ev = engine.latestEvent
    if (armed && ev) {
      if (ev.type === 'order_created') {
        setOutcome({ kind: 'created', orderHash: ev.orderHash })
        setArmed(false)
        setCreating(false)
      } else if (ev.type === 'order_error') {
        const tier = requiredTierFromError(ev.error)
        if (tier) {
          // the server re-classified: back to the review, consent for ITS tier (never a weaker one — reopenTier)
          setConflictTier(tier)
          setOutcome(null)
          setSigned(null)
        } else {
          setOutcome({ kind: 'failed', error: ev.error })
        }
        setArmed(false)
        setCreating(false)
      }
    }
  }
  // The engine dropped its frozen review on its own (its chain / account reset effects, or a guard in confirmOrder that returns
  // without an event) while nothing is running: the attempt is over, the review sheet is what is left.
  if (armed && !creating && !engine.isSubmitting && !engine.pendingOrder && !outcome) setArmed(false)

  const frozen = engine.pendingOrder ?? signed
  const phase: DcaPhase =
    outcome?.kind === 'created' ? 'created'
    : outcome?.kind === 'failed' ? 'failed'
    : armed && engine.isSubmitting ? 'signing'
    : engine.pendingOrder ? 'frozen'
    : creating ? 'creating'
    : review ? 'review'
    : 'idle'

  /** `prepare()` resolved: the review opens on the draft v1 would hand `createOrder`. */
  const open = useCallback((r: PreparedReview) => {
    setReview(r)
    setConflictTier(undefined)
    setOutcome(null)
    setSigned(null)
    setDraft(null)
  }, [])

  /**
   * The review's Create DCA = v1's `handleCreate(ack)` from the consent confirm onwards: `startWaitingSound()` (DCAPanel.tsx:825 — v1
   * restarts the loop there because the consent dialog stopped it; on the on-chain tier the loop the form press started is still
   * running and v1 starts nothing new) and then `await onSubmit(config)` (:993). Double presses are ignored while an attempt is live.
   */
  const create = useCallback(
    async (config: CreateOrderConfig, restartWaiting: boolean = !!config.floorAck) => {
      if (creating || engine.pendingOrder || engine.isSubmitting) return
      setDraft(config)
      setOutcome(null)
      setSigned(null)
      setCreating(true)
      setArmed(true)
      if (restartWaiting) startWaitingSound()
      try {
        await engine.createOrder(config)
      } catch (err) {
        setOutcome({ kind: 'failed', error: err instanceof Error ? err.message : String(err) })
        setArmed(false)
      } finally {
        setCreating(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `engine` is a fresh object each render; its fields are what matter
    [creating, engine.createOrder, engine.pendingOrder, engine.isSubmitting],
  )

  /** v1's OrderReviewModal `onConfirm={confirmOrder}` (DCAPanel.tsx:255): sign the FROZEN order, then POST. */
  const sign = useCallback(() => {
    if (!engine.pendingOrder || engine.isSubmitting) return
    setSigned(engine.pendingOrder)
    setArmed(true)
    void engine.confirmOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
  }, [engine.pendingOrder, engine.isSubmitting, engine.confirmOrder])

  /** v1's OrderReviewModal `onCancel={clearPendingOrder}` (DCAPanel.tsx:255). v1 leaves the waiting loop running there; v2 stops it (B5 rule). */
  const cancelSign = useCallback(() => {
    engine.clearPendingOrder()
    setArmed(false)
    setSigned(null)
    setReview(null)
    setConflictTier(undefined)
    stopWaitingSound()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
  }, [engine.clearPendingOrder])

  /** The review's Cancel / Esc: nothing is frozen; the loop the form press started has nothing left to wait for. */
  const closeReview = useCallback(() => {
    setReview(null)
    setConflictTier(undefined)
    stopWaitingSound()
  }, [])

  /** The failure sheet's Retry: the same config, the same function (v1: press Start again — the loop starts again, DCAPanel.tsx:825). */
  const retry = useCallback(() => {
    if (draft) void create(draft, true)
  }, [draft, create])

  /** The created / failed sheet is dismissed (View positions, New DCA, Esc): back to the form. */
  const done = useCallback(() => {
    setOutcome(null)
    setSigned(null)
    setReview(null)
    setConflictTier(undefined)
    setDraft(null)
  }, [])

  /**
   * The form's draft changed under an open sheet (B5's trade-key rule, owner: auto-close): the review closes; a frozen order is dropped
   * (`clearPendingOrder` — the engine's own reset, the same call its chain / account effects make). An order with the wallet or already
   * settled is left alone: the form is behind a modal sheet and cannot have changed by hand.
   */
  const reset = useCallback(() => {
    if (phase !== 'review' && phase !== 'frozen') return
    if (engine.pendingOrder) engine.clearPendingOrder()
    setArmed(false)
    setReview(null)
    setConflictTier(undefined)
    setSigned(null)
    stopWaitingSound()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
  }, [phase, engine.pendingOrder, engine.clearPendingOrder])

  return { phase, review, conflictTier, frozen, outcome, open, create, sign, cancelSign, closeReview, retry, done, reset }
}

export type DcaLifecycle = ReturnType<typeof useDcaLifecycle>
