'use client'

import { createContext, useContext, useCallback, useState, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

/* ── Types ── */
export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'loading'

export interface Toast {
  id: string
  type: ToastType
  title: string
  description?: string
  /** Auto-dismiss in ms (0 = sticky) */
  duration?: number
  /** Transaction hash — shows Etherscan link */
  txHash?: string
  /** Custom action button */
  action?: { label: string; onClick: () => void }
}

interface ToastContext {
  toast: (t: Omit<Toast, 'id'>) => string
  dismiss: (id: string) => void
  update: (id: string, partial: Partial<Omit<Toast, 'id'>>) => void
}

const Ctx = createContext<ToastContext | null>(null)

export function useToast() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be inside <ToastProvider>')
  return ctx
}

/* ── Provider ── */
const MAX_TOASTS = 5

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)
  const timers = useRef<Record<string, NodeJS.Timeout>>({})

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current[id])
    delete timers.current[id]
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useCallback((t: Omit<Toast, 'id'>): string => {
    const id = `toast-${++counter.current}`
    const duration = t.duration ?? (t.type === 'error' ? 8000 : t.type === 'loading' ? 0 : 5000)

    setToasts(prev => {
      const next = [...prev, { ...t, id, duration }]
      // Trim oldest if over limit
      return next.length > MAX_TOASTS ? next.slice(-MAX_TOASTS) : next
    })

    if (duration > 0) {
      timers.current[id] = setTimeout(() => dismiss(id), duration)
    }

    return id
  }, [dismiss])

  const update = useCallback((id: string, partial: Partial<Omit<Toast, 'id'>>) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, ...partial } : t))

    // If type changed to non-loading, auto-dismiss after 5s
    if (partial.type && partial.type !== 'loading') {
      clearTimeout(timers.current[id])
      const dur = partial.type === 'error' ? 8000 : 5000
      timers.current[id] = setTimeout(() => dismiss(id), dur)
    }
  }, [dismiss])

  return (
    <Ctx.Provider value={{ toast, dismiss, update }}>
      {children}
      {/* ── Toast container ── */}
      <div className="fixed bottom-4 right-4 z-[200] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        <AnimatePresence mode="popLayout">
          {toasts.map(t => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  )
}

/* ── Toast item ── */
const ICONS: Record<ToastType, React.ReactNode> = {
  success: (
    <svg className="h-5 w-5 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  ),
  error: (
    <svg className="h-5 w-5 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <circle cx="12" cy="12" r="10" strokeWidth={2} />
      <path strokeLinecap="round" d="M15 9l-6 6M9 9l6 6" />
    </svg>
  ),
  warning: (
    <svg className="h-5 w-5 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  ),
  info: (
    <svg className="h-5 w-5 shrink-0 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
    </svg>
  ),
  loading: (
    <svg className="h-5 w-5 shrink-0 animate-spin text-cream-gold" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={3} />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  ),
}

const BORDER_COLORS: Record<ToastType, string> = {
  success: 'border-emerald-500/20',
  error: 'border-red-500/20',
  warning: 'border-amber-500/20',
  info: 'border-blue-500/20',
  loading: 'border-cream-15',
}

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 24, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className={`relative overflow-hidden rounded-xl border ${BORDER_COLORS[t.type]} bg-surface-secondary/95 shadow-xl shadow-black/30 backdrop-blur-xl`}
    >
      {/* Top accent bar */}
      <div className={`h-0.5 ${
        t.type === 'success' ? 'bg-emerald-500' :
        t.type === 'error' ? 'bg-red-500' :
        t.type === 'warning' ? 'bg-amber-500' :
        t.type === 'info' ? 'bg-blue-500' :
        'bg-cream-gold'
      }`} />

      <div className="flex gap-3 px-4 py-3">
        {/* Icon */}
        {ICONS[t.type]}

        {/* Content */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-cream">{t.title}</p>
          {t.description && (
            <p className="mt-0.5 text-xs leading-relaxed text-cream-50">{t.description}</p>
          )}
          {/* Tx hash link */}
          {t.txHash && (
            <a
              href={`https://etherscan.io/tx/${t.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-cream-gold transition-colors hover:text-cream"
            >
              View on Etherscan
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline strokeLinecap="round" strokeLinejoin="round" points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          )}
          {/* Custom action */}
          {t.action && (
            <button
              onClick={t.action.onClick}
              className="mt-1.5 rounded-md bg-cream-08 px-2.5 py-1 text-[11px] font-semibold text-cream transition-colors hover:bg-cream-15"
            >
              {t.action.label}
            </button>
          )}
        </div>

        {/* Close button */}
        {t.type !== 'loading' && (
          <button
            onClick={onDismiss}
            className="shrink-0 self-start rounded p-0.5 text-cream-35 transition-colors hover:text-cream"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </motion.div>
  )
}
