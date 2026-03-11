'use client'

import { type ReactNode, useState, useEffect, useRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit'
import { config } from '@/lib/wagmiConfig'
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext'
import { ToastProvider } from '@/components/ToastProvider'
import BackgroundMusic from '@/components/BackgroundMusic'
import { assertEnv } from '@/lib/env-validation'

import '@rainbow-me/rainbowkit/styles.css'

function RainbowKitWithTheme({ children }: { children: ReactNode }) {
  const { resolved } = useTheme()

  const rkTheme = resolved === 'dark'
    ? darkTheme({
        accentColor: '#C8B89A',
        accentColorForeground: '#080B10',
        borderRadius: 'medium',
        overlayBlur: 'small',
      })
    : lightTheme({
        accentColor: '#8C7A5A',
        accentColorForeground: '#FFFDF8',
        borderRadius: 'medium',
        overlayBlur: 'small',
      })

  return (
    <RainbowKitProvider theme={rkTheme} locale="en">
      {children}
    </RainbowKitProvider>
  )
}

export default function Providers({ children }: { children: ReactNode }) {
  // [BUGFIX] Create QueryClient inside component — module-scope singletons share
  // state across SSR requests in serverless/edge environments, causing data leaks.
  const [queryClient] = useState(() => new QueryClient())

  // [Phase-1] Validate environment variables on first mount
  const envChecked = useRef(false)
  useEffect(() => {
    if (!envChecked.current) {
      envChecked.current = true
      try { assertEnv() } catch { /* production build will throw — dev logs only */ }
    }
  }, [])

  return (
    <ThemeProvider>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitWithTheme>
            <ToastProvider>
              <BackgroundMusic />
              {children}
            </ToastProvider>
          </RainbowKitWithTheme>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  )
}
