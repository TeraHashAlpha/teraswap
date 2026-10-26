'use client'

import { useCallback, useState, type MouseEvent } from 'react'
import { HelpDrawer } from './HelpDrawer'
import { useBackgroundMusic } from './music'

const FAB =
  'fixed bottom-[calc(var(--photo-footer-band)+12px)] z-50 flex h-11 w-11 items-center justify-center rounded-full border border-v2-border bg-v2-surface text-v2-cream ' +
  'hover:border-v2-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal'

/** ♫ bottom-left (♫ ↔ ✕). Toggles ONLY the background music — the same `toggleBackgroundMusic()` v1 calls. */
export function MusicToggle() {
  const { on, toggle } = useBackgroundMusic()
  // stopPropagation keeps this click from reaching the document-level "first interaction" listener of v1's root
  // BackgroundMusic (mounted by the root layout), which would start music right after we muted it.
  const onClick = useCallback((e: MouseEvent) => {
    e.stopPropagation()
    toggle()
  }, [toggle])
  return (
    <button
      type="button"
      data-v2-music-toggle=""
      onClick={onClick}
      className={`${FAB} left-5`}
      aria-label={on ? 'Turn music off' : 'Turn music on'}
      aria-pressed={on}
      title={on ? 'Turn music off' : 'Turn music on'}
    >
      <span aria-hidden="true">{on ? '♫' : '✕'}</span>
    </button>
  )
}

/** "?" bottom-right; opens the Help Center drawer. */
export function HelpFab() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className={`${FAB} right-5`} aria-label="Open help">
          <span aria-hidden="true">?</span>
        </button>
      ) : null}
      <HelpDrawer open={open} onClose={close} />
    </>
  )
}
