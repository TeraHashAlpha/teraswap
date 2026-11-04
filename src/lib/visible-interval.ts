/**
 * [fix/v1-maintenance C3] `setInterval` that does not run in a hidden tab — for the API timers that, unlike
 * TanStack's `refetchInterval` (which already pauses in the background, see `rpc-polling.ts`), keep firing on
 * their own. Hidden → the timer is cleared; visible again → ONE immediate tick, then the cadence resumes.
 * Returns the disposer (clears the timer and the `visibilitychange` listener).
 */
export function setVisibleInterval(tick: () => void, ms: number): () => void {
  if (typeof document === 'undefined') {
    const id = setInterval(tick, ms)
    return () => clearInterval(id)
  }
  let id: ReturnType<typeof setInterval> | null = null
  const hidden = () => document.visibilityState === 'hidden'
  const start = () => { if (id === null) id = setInterval(tick, ms) }
  const stop = () => { if (id !== null) { clearInterval(id); id = null } }

  if (!hidden()) start()
  const onVisibility = () => {
    if (hidden()) { stop(); return }
    if (id === null) { tick(); start() } // returned to the tab after a pause: refresh once, then resume
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
  }
}
