'use client'

import { useCallback, useState } from 'react'
import type { PendingOrderReview } from '@/hooks/useOrderEngine'
import type { CreateOrderConfig, OrderEngineEvent } from '@/lib/order-engine'
import { stopWaitingSound } from '@/lib/sounds'
import { consentTier, reopenTier, requiredTierFromError, type WeakerTier } from './dca-model'
import type { PrepareFn, PreparedReview } from './use-dca-form'

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
 * idle → review (the B6a sheet, from `prepare()`) → creating (`prepare()` again, then `createOrder` running) → frozen (the engine's `pendingOrder`: the EIP-712
 * review) → signing (`confirmOrder`: wallet signature + POST, the engine's `isSubmitting`) → created | failed (the engine's event).
 */
export type DcaPhase = 'idle' | 'review' | 'creating' | 'frozen' | 'signing' | 'created' | 'failed'

export type DcaOutcome = { kind: 'created'; orderHash: string } | { kind: 'failed'; error: string }

/**
 * [ADR-025 / B6b] The v2 DCA create lifecycle over v1's `useOrderEngine`, called with DCAPanel's own arguments in DCAPanel's own
 * order: consent → `prepare()` afresh (v1's `handleCreate(ack)`, DCAPanel.tsx:1209 → :794-993: every gate, the route check, a fresh
 * `deriveSigningMinAmountOut`) → `createOrder(config)` (:993 `await onSubmit(config)`, the hook FREEZES, nothing is signed) → the
 * EIP-712 review (v1's OrderReviewModal) → `confirmOrder()` (OrderReviewModal.tsx:171 `onClick={onConfirm}`: sign + POST) →
 * `order_created` / `order_error`. Cancel = `clearPendingOrder` (OrderReviewModal.tsx:182). The UI never builds a struct, a
 * floor, a nonce or a deadline: it hands the hook the draft `prepare()` built a moment ago — never a draft built when the review opened,
 * never a stored acknowledgement (A70 M-1) — and renders what the hook froze.
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
  }, [])

  /** One attempt: v1's create step again (`prepare`), then — unless a gate said no or a consent is due — `createOrder` with the fresh draft. */
  async function run(prepare: PrepareFn, opts: { ack?: WeakerTier; startSound: boolean }) {
    setOutcome(null)
    setSigned(null)
    setCreating(true)
    let result: Awaited<ReturnType<PrepareFn>> = { ok: false }
    try {
      result = await prepare(opts)
    } catch {
      result = { ok: false }
    }
    if (!result.ok) {
      // v1 returns early where a gate says no: the form shows why. prepare() already stopped the loop where it started one.
      setCreating(false)
      setReview(null)
      setConflictTier(undefined)
      stopWaitingSound()
      return
    }
    const fresh = result.review
    const due = reopenTier(consentTier(fresh.info), conflictTier) ?? consentTier(fresh.info)
    const given = fresh.draft.floorAck?.tier ?? null
    if (due && (given === null || reopenTier(given, due) !== null)) {
      // A consent is due that was not given for THIS draft (none, or a weaker tier than the one now due): the review (fresh floor, fresh
      // tier) asks for it, box unticked. Nothing is created.
      setReview(fresh)
      setCreating(false)
      return
    }
    setReview(fresh)
    setArmed(true)
    try {
      await engine.createOrder(fresh.draft)
    } catch (err) {
      setOutcome({ kind: 'failed', error: err instanceof Error ? err.message : String(err) })
      setArmed(false)
    } finally {
      setCreating(false)
    }
  }

  /**
   * The review's Create DCA = v1's `handleCreate(ack)` from the consent confirm onwards (A70 M-1): `prepare({ ack })` runs v1's whole create
   * step AGAIN — the gates (depeg, oracle, pause, cap / floor, schedule), the router and route checks, a fresh `deriveSigningMinAmountOut`
   * from the prices as they are now — and `createOrder` gets THAT draft. A gate that now blocks resolves `{ ok: false }`: nothing reaches
   * the engine, the review closes onto the form (whose banner carries v1's copy for it). `ack` is the tier whose box is ticked on the sheet
   * in front of the user — with one the waiting loop restarts (v1 :825, after the consent dialog stopped it); without one (the on-chain
   * tier) the loop the form press started is still running and nothing new starts. If the fresh tier now asks for a consent the user has
   * not given (the server moved), the review reopens on it, unticked — `createOrder` is not called. Double presses are ignored while live.
   */
  const create = useCallback(
    async (prepare: PrepareFn, ack?: WeakerTier) => {
      if (creating || engine.pendingOrder || engine.isSubmitting) return
      await run(prepare, { ack, startSound: !!ack })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `engine` is a fresh object each render; its fields are what matter
    [creating, engine.createOrder, engine.pendingOrder, engine.isSubmitting, conflictTier],
  )

  /**
   * The failure sheet's Retry = v1's "press Start again" (A70 M-1): the same fresh `prepare()` as a first press — no stored draft, no
   * stored acknowledgement. On the on-chain tier it goes straight on to `createOrder(fresh)`; when a consent is due (the tier, or a stronger
   * one a 409 named earlier in this attempt) the review reopens with the box UNTICKED and Create makes the call.
   */
  const retry = useCallback(
    async (prepare: PrepareFn) => {
      if (creating || engine.pendingOrder || engine.isSubmitting) return
      await run(prepare, { startSound: true })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
    [creating, engine.createOrder, engine.pendingOrder, engine.isSubmitting, conflictTier],
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

  /** The created / failed sheet is dismissed (View positions, New DCA, Esc): back to the form. */
  const done = useCallback(() => {
    setOutcome(null)
    setSigned(null)
    setReview(null)
    setConflictTier(undefined)
  }, [])

  /**
   * The form's draft changed under an open sheet (B5's trade-key rule, owner: auto-close): the review closes; a frozen order is dropped
   * (`clearPendingOrder` — the engine's own reset, the same call its chain / account effects make). An order with the wallet or already
   * settled is left alone: the form is behind a modal sheet and cannot have changed by hand. `reviewOnly` (a PRICE moved, A70 M-1): the
   * review closes — what it prints is the floor from the old price — but a frozen order is not dropped: the sign sheet prints the exact
   * struct the wallet will be asked to sign, and the feeds tick every 30 s.
   */
  const reset = useCallback((opts?: { reviewOnly?: boolean }) => {
    if (phase !== 'review' && !(phase === 'frozen' && !opts?.reviewOnly)) return
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
