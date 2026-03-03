'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { helpSections } from '@/lib/help-content'

interface HelpDrawerProps {
  open: boolean
  onClose: () => void
}

export default function HelpDrawer({ open, onClose }: HelpDrawerProps) {
  const [expandedSection, setExpandedSection] = useState<number | null>(0)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)

  const toggleSection = (idx: number) =>
    setExpandedSection(expandedSection === idx ? null : idx)

  const toggleItem = (key: string) =>
    setExpandedItem(expandedItem === key ? null : key)

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-[60] backdrop-blur-sm"
            style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          {/* Drawer — forced dark background via inline style so it never inherits light theme */}
          <motion.aside
            className="fixed bottom-0 right-0 top-0 z-[70] flex w-full max-w-[420px] flex-col shadow-2xl"
            style={{
              backgroundColor: '#0c1017',
              borderLeft: '1px solid rgba(200,184,154,0.08)',
            }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: '1px solid rgba(200,184,154,0.08)' }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full font-semibold"
                  style={{ backgroundColor: 'rgba(200,184,154,0.15)', color: '#C8B89A' }}
                >
                  ?
                </span>
                <h2
                  className="font-clash text-lg font-semibold"
                  style={{ color: '#E8E0D4' }}
                >
                  Help Center
                </h2>
              </div>
              <button
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg transition-opacity hover:opacity-70"
                style={{ color: '#9A9083' }}
                aria-label="Close help"
              >
                ✕
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {helpSections.map((section, sIdx) => (
                <div key={section.title} className="mb-3">
                  {/* Section header */}
                  <button
                    onClick={() => toggleSection(sIdx)}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition-opacity hover:opacity-80"
                  >
                    <span
                      className="font-clash text-[13px] font-semibold uppercase tracking-wider"
                      style={{ color: '#C8B89A' }}
                    >
                      {section.title}
                    </span>
                    <motion.span
                      style={{ color: '#9A9083' }}
                      animate={{ rotate: expandedSection === sIdx ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      ▾
                    </motion.span>
                  </button>

                  {/* Section items */}
                  <AnimatePresence initial={false}>
                    {expandedSection === sIdx && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25, ease: 'easeInOut' }}
                        className="overflow-hidden"
                      >
                        {section.items.map((item, iIdx) => {
                          const key = `${sIdx}-${iIdx}`
                          const isOpen = expandedItem === key
                          return (
                            <div
                              key={key}
                              className="ml-2 pl-3"
                              style={{ borderLeft: '1px solid rgba(200,184,154,0.08)' }}
                            >
                              <button
                                onClick={() => toggleItem(key)}
                                className="flex w-full items-center gap-2 py-2.5 text-left text-[13px] transition-opacity hover:opacity-80"
                                style={{ color: '#E8E0D4' }}
                              >
                                <motion.span
                                  className="inline-block text-[10px]"
                                  style={{ color: '#9A9083' }}
                                  animate={{ rotate: isOpen ? 90 : 0 }}
                                  transition={{ duration: 0.15 }}
                                >
                                  ▸
                                </motion.span>
                                {item.q}
                              </button>

                              <AnimatePresence initial={false}>
                                {isOpen && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{
                                      duration: 0.2,
                                      ease: 'easeInOut',
                                    }}
                                    className="overflow-hidden"
                                  >
                                    <p
                                      className="pb-3 pl-5 text-[12.5px] leading-relaxed"
                                      style={{ color: '#A09888' }}
                                    >
                                      {item.a}
                                    </p>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          )
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}

              {/* External links */}
              <div
                className="mt-6 pt-5"
                style={{ borderTop: '1px solid rgba(200,184,154,0.08)' }}
              >
                <p
                  className="mb-3 text-[12px] font-semibold uppercase tracking-wider"
                  style={{ color: '#9A9083' }}
                >
                  Need more help?
                </p>
                <div className="flex flex-col gap-2">
                  <a
                    href="https://x.com/TeraHash"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[13px] transition-opacity hover:opacity-80"
                    style={{
                      color: '#E8E0D4',
                      border: '1px solid rgba(200,184,154,0.08)',
                    }}
                  >
                    <span>𝕏</span> Follow on X
                  </a>
                </div>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
