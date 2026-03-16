import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Only send errors in production
  enabled: process.env.NODE_ENV === 'production',

  // Sample 100% of errors, 10% of transactions (keep free tier usage low)
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,

  // Filter noise — don't report these
  ignoreErrors: [
    // Wallet rejections (user cancelled)
    'User rejected the request',
    'User denied transaction',
    'ACTION_REJECTED',
    // Network flakiness
    'Failed to fetch',
    'NetworkError',
    'Load failed',
    // Browser extensions injecting errors
    'ResizeObserver loop',
    'Non-Error promise rejection',
  ],

  beforeSend(event) {
    // Don't send PII (wallet addresses are pseudonymous but still filter)
    if (event.request?.cookies) delete event.request.cookies
    return event
  },
})
