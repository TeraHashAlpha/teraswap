/**
 * Shared utilities for alert channels.
 */

/** Escape user-controlled strings for safe HTML interpolation (Telegram HTML, Email). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/** Fetch timeout (ms) for all outbound alert channel requests. */
export const CHANNEL_FETCH_TIMEOUT_MS = 5_000
