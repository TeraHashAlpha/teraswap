'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type ThemeMode = 'dark' | 'light' | 'system'

interface ThemeContextType {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  resolved: 'dark' | 'light' // what is actually applied
}

const ThemeContext = createContext<ThemeContextType>({
  mode: 'dark',
  setMode: () => {},
  resolved: 'dark',
})

export function useTheme() {
  return useContext(ThemeContext)
}

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark')
  const [resolved, setResolved] = useState<'dark' | 'light'>('dark')

  // Load saved preference on mount
  useEffect(() => {
    const saved = localStorage.getItem('teraswap-theme') as ThemeMode | null
    if (saved && ['dark', 'light', 'system'].includes(saved)) {
      setModeState(saved)
    }
  }, [])

  // Resolve theme and apply class
  useEffect(() => {
    const apply = (resolvedTheme: 'dark' | 'light') => {
      setResolved(resolvedTheme)
      const root = document.documentElement
      root.classList.remove('dark', 'light')
      root.classList.add(resolvedTheme)
      // Update meta theme-color for mobile browsers
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) {
        meta.setAttribute('content', resolvedTheme === 'dark' ? '#080B10' : '#F5F0E8')
      }
    }

    if (mode === 'system') {
      apply(getSystemTheme())
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      apply(mode)
    }
  }, [mode])

  function setMode(m: ThemeMode) {
    setModeState(m)
    localStorage.setItem('teraswap-theme', m)
  }

  return (
    <ThemeContext.Provider value={{ mode, setMode, resolved }}>
      {children}
    </ThemeContext.Provider>
  )
}
