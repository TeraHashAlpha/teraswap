'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuoteChainId } from '@/hooks/useChainId'
import { getChainConfig } from '@/lib/chains/registry'
import { cx } from '../primitives/cx'

/**
 * [ADR-025] v2 toasts (pack 05): top-right stack, max 3 visible, newest on top, left bar by type, a loading toast is
 * replaced by its result via `update`. The API is v1's ToastProvider API (toast / dismiss / update, same fields and
 * default durations: error 8 s, loading sticky, else 5 s, `dedupKey` replaces) so callers can switch with an import.
 * The tx link is chain-aware (v1's is etherscan-only). No sound on toasts (pack 05 "SOUND").
 */
export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'loading'

export interface Toast {
  id: string
  type: ToastType
  title: string
  description?: string
  /** Auto-dismiss in ms (0 = sticky). */
  duration?: number
  txHash?: string
  /** Chain of `txHash` for the explorer link; defaults to the selected chain. */
  chainId?: number
  action?: { label: string; onClick: () => void }
  dedupKey?: string
}

interface ToastApi {
  toast: (t: Omit<Toast, 'id'>) => string
  dismiss: (id: string) => void
  update: (id: string, partial: Partial<Omit<Toast, 'id'>>) => void
}

const Ctx = createContext<ToastApi | null>(null)

export function useV2Toast(): ToastApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useV2Toast must be inside <V2ToastProvider>')
  return ctx
}

export const MAX_VISIBLE_TOASTS = 3

export function defaultDuration(type: ToastType): number {
  return type === 'error' ? 8000 : type === 'loading' ? 0 : 5000
}

export function V2ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const clear = (id: string) => {
    clearTimeout(timers.current[id])
    delete timers.current[id]
  }

  const dismiss = useCallback((id: string) => {
    clear(id)
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (t: Omit<Toast, 'id'>): string => {
      const id = `v2-toast-${++counter.current}`
      const duration = t.duration ?? defaultDuration(t.type)
      setToasts((prev) => {
        const base = t.dedupKey ? prev.filter((e) => (e.dedupKey === t.dedupKey ? (clear(e.id), false) : true)) : prev
        return [...base, { ...t, id, duration }].slice(-MAX_VISIBLE_TOASTS)
      })
      if (duration > 0) timers.current[id] = setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss],
  )

  const update = useCallback(
    (id: string, partial: Partial<Omit<Toast, 'id'>>) => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, ...partial } : t)))
      if (partial.type && partial.type !== 'loading') {
        clear(id)
        timers.current[id] = setTimeout(() => dismiss(id), partial.duration ?? defaultDuration(partial.type))
      }
    },
    [dismiss],
  )

  const api = useMemo(() => ({ toast, dismiss, update }), [toast, dismiss, update])

  return (
    <Ctx.Provider value={api}>
      {children}
      <div role="region" aria-label="Notifications" className="pointer-events-none fixed right-4 top-24 z-[200] flex w-[calc(100vw-2rem)] max-w-[360px] flex-col-reverse gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  )
}

const BAR: Record<ToastType, string> = {
  loading: 'bg-v2-cream',
  success: 'bg-v2-green',
  warning: 'bg-v2-amber',
  error: 'bg-v2-red',
  info: 'bg-v2-teal',
}

function txUrl(txHash: string, chainId: number): string {
  try {
    return `${getChainConfig(chainId).blockExplorer}/tx/${txHash}`
  } catch {
    return `${getChainConfig(1).blockExplorer}/tx/${txHash}`
  }
}

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const selectedChain = useQuoteChainId()
  return (
    <div
      role={t.type === 'error' ? 'alert' : 'status'}
      data-toast-type={t.type}
      className="ts-v2-toast pointer-events-auto relative flex gap-3 overflow-hidden rounded-v2-card border border-v2-border bg-v2-surface py-3 pl-5 pr-3"
    >
      <span aria-hidden="true" className={cx('absolute inset-y-0 left-0 w-1', BAR[t.type])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-v2-text">{t.title}</p>
        {t.description ? <p className="mt-0.5 text-xs text-v2-muted">{t.description}</p> : null}
        {t.txHash ? (
          <a href={txUrl(t.txHash, t.chainId ?? selectedChain)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-v2-text underline-offset-2 hover:underline">
            View on explorer ↗
          </a>
        ) : null}
        {t.action ? (
          <button type="button" onClick={t.action.onClick} className="mt-1.5 block min-h-[32px] font-v2-mono text-[11px] font-bold uppercase tracking-[1.5px] text-v2-cream">
            {t.action.label}
          </button>
        ) : null}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification" className="flex h-8 w-8 shrink-0 items-center justify-center self-start text-v2-muted hover:text-v2-text">
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  )
}
