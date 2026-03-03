'use client'

import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit'
import { config } from '@/lib/wagmiConfig'
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext'
import { ToastProvider } from '@/components/ToastProvider'

import '@rainbow-me/rainbowkit/styles.css'

const queryClient = new QueryClient()

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
  return (
    <ThemeProvider>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitWithTheme>
            <ToastProvider>
              {children}
            </ToastProvider>
          </RainbowKitWithTheme>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  )
}
