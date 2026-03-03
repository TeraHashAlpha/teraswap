'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import HelpDrawer from './HelpDrawer'

export default function HelpButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* Floating button — bottom-right, hidden on landing */}
      <AnimatePresence>
        {!open && (
          <motion.button
            onClick={() => setOpen(true)}
            className="fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-cream-gold/20 bg-surface-secondary/90 text-cream-gold shadow-lg shadow-black/30 backdrop-blur-md transition-colors hover:border-cream-gold/40 hover:bg-surface-secondary"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
            aria-label="Open help"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>

      <HelpDrawer open={open} onClose={() => setOpen(false)} />
    </>
  )
}
