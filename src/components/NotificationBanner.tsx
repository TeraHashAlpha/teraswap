'use client'

import { useNotificationPrompt } from '@/hooks/useOrderNotifications'
import { motion, AnimatePresence } from 'framer-motion'

/**
 * A dismissible banner that asks users to enable browser notifications.
 * Only shows once (until dismissed or permission is granted/denied).
 * Renders nothing on unsupported browsers or if already decided.
 */
export default function NotificationBanner() {
  const { shouldShow, request, dismiss } = useNotificationPrompt()

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25 }}
          className="overflow-hidden"
        >
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-xl border border-cream-08 bg-surface-secondary/80 px-4 py-2.5 backdrop-blur-sm">
            <div className="flex items-center gap-2.5">
              {/* Bell icon */}
              <svg className="h-5 w-5 shrink-0 text-cream-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
              </svg>
              <p className="text-sm text-cream-70">
                Enable notifications to know when your orders fill — even in background.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={request}
                className="rounded-lg bg-cream-gold/90 px-3 py-1.5 text-xs font-semibold text-dark-base transition-colors hover:bg-cream-gold"
              >
                Enable
              </button>
              <button
                onClick={dismiss}
                className="rounded-lg px-2 py-1.5 text-xs text-cream-35 transition-colors hover:text-cream-70"
              >
                Not now
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
