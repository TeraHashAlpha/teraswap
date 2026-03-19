'use client'

import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * Error boundary around SwapBox to prevent full-page crashes.
 * Q52: A rendering crash in quote display or token selector
 * should show a reset button, not crash the entire app.
 */
export default class SwapErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[SwapErrorBoundary]', error, errorInfo.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="mx-auto w-full max-w-[460px] rounded-2xl border border-danger/30 bg-surface-secondary/80 p-6 text-center">
          <div className="mb-3 text-2xl">&#9888;</div>
          <h3 className="mb-2 text-sm font-semibold text-cream-90">Something went wrong</h3>
          <p className="mb-4 text-xs text-cream-50">
            The swap interface encountered an error. Your funds are safe.
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="rounded-xl bg-cream-gold px-6 py-2 text-sm font-bold text-[#080B10] transition-transform hover:scale-105"
          >
            Reset &amp; Try Again
          </button>
          {this.state.error && (
            <p className="mt-3 text-[10px] text-cream-35 break-all">
              {this.state.error.message.slice(0, 200)}
            </p>
          )}
        </div>
      )
    }

    return this.props.children
  }
}
