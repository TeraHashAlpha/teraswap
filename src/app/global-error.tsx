'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html>
      <body style={{ background: '#080B10', color: '#F5F0E8', fontFamily: 'system-ui', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', margin: 0 }}>
        <div style={{ textAlign: 'center', maxWidth: 400, padding: 24 }}>
          <h2 style={{ fontSize: 24, marginBottom: 12 }}>Something went wrong</h2>
          <p style={{ fontSize: 14, opacity: 0.6, marginBottom: 24 }}>
            An unexpected error occurred. The team has been notified.
          </p>
          <button
            onClick={reset}
            style={{ background: '#C8B89A', color: '#080B10', border: 'none', borderRadius: 12, padding: '12px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            Try Again
          </button>
        </div>
      </body>
    </html>
  )
}
