'use client'

import { useState, useRef, useEffect } from 'react'
import { useTheme, type ThemeMode } from '@/contexts/ThemeContext'

const OPTIONS: { mode: ThemeMode; label: string; icon: string }[] = [
  { mode: 'dark', label: 'Dark', icon: '☽' },
  { mode: 'light', label: 'Light', icon: '☀' },
  { mode: 'system', label: 'Device', icon: '⚙' },
]

export default function ThemeToggle() {
  const { mode, setMode, resolved } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const current = OPTIONS.find(o => o.mode === mode) ?? OPTIONS[0]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-cream-15 text-sm text-cream-65 transition-all hover:border-cream-50 hover:text-cream dark:border-cream-15 dark:text-cream-65 dark:hover:border-cream-50 dark:hover:text-cream light:border-gray-300 light:text-gray-500 light:hover:border-gray-500 light:hover:text-gray-800"
        title={`Theme: ${current.label}`}
      >
        {current.icon}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 flex flex-col overflow-hidden rounded-xl border border-cream-15 bg-surface-secondary shadow-xl shadow-black/30 backdrop-blur-xl dark:border-cream-15 dark:bg-surface-secondary light:border-gray-200 light:bg-white light:shadow-gray-200/50">
          {OPTIONS.map(opt => (
            <button
              key={opt.mode}
              onClick={() => { setMode(opt.mode); setOpen(false) }}
              className={`flex items-center gap-2 px-4 py-2 text-left text-xs font-medium transition-colors ${
                mode === opt.mode
                  ? 'bg-cream-08 text-cream dark:bg-cream-08 dark:text-cream light:bg-gray-100 light:text-gray-900'
                  : 'text-cream-50 hover:bg-cream-04 hover:text-cream dark:text-cream-50 dark:hover:bg-cream-04 dark:hover:text-cream light:text-gray-500 light:hover:bg-gray-50 light:hover:text-gray-800'
              }`}
            >
              <span className="w-4 text-center">{opt.icon}</span>
              <span>{opt.label}</span>
              {mode === opt.mode && <span className="ml-auto text-[10px] text-cream-35 dark:text-cream-35 light:text-gray-400">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
