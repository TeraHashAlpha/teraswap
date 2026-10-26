'use client'

import { useNotificationPrompt } from '@/hooks/useOrderNotifications'
import { EyebrowLabel } from '../primitives'

/**
 * [ADR-025] Notification banner (pack 05). The slot carries v1's one banner — the browser-notification prompt —
 * with its existing copy and its existing hook (shown once; dismissed state is v1's localStorage key).
 */
export function NoticeBanner() {
  const { shouldShow, request, dismiss } = useNotificationPrompt()
  if (!shouldShow) return null
  return (
    <div role="region" aria-label="Notice" className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-v2-control border border-v2-border bg-v2-surface px-4 py-2.5 sm:mx-8">
      <EyebrowLabel className="border-v2-teal text-v2-teal">Notice</EyebrowLabel>
      <p className="min-w-0 flex-1 text-sm text-v2-text">Enable notifications to know when your orders fill — even in background.</p>
      <button type="button" onClick={request} className="min-h-[44px] px-3 font-v2-mono text-xs font-bold uppercase tracking-[1.5px] text-v2-cream">
        Enable
      </button>
      <button type="button" onClick={dismiss} className="min-h-[44px] px-3 font-v2-mono text-xs uppercase tracking-[1.5px] text-v2-muted">
        Not now
      </button>
    </div>
  )
}
