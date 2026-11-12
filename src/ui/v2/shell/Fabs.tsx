'use client'

import { useCallback, useState, type MouseEvent } from 'react'
import { MusicSpeaker } from '../icons/MusicSpeaker'
import { HelpDrawer } from './HelpDrawer'
import { useBackgroundMusic } from './music'

const FAB =
  // Round 7 D3 item 12: a 1 px hairline ring, no fill (the photo shows through).
  'fixed bottom-3 sm:bottom-[calc(var(--photo-footer-band)+12px)] z-50 flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--hairline-ring)] bg-transparent text-v2-cream ' +
  'hover:border-v2-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal'

/** ♫ bottom-left (speaker ↔ muted speaker). The SOUND switch: off silences the music and every UI sound — the same `toggleBackgroundMusic()` v1 calls. */
export function MusicToggle() {
  const { on, toggle } = useBackgroundMusic()
  // stopPropagation only helps when React's root is an element below `document`. In production Next hydrates INTO
  // `document`, so v1's root BackgroundMusic listener (a sibling on the same node) still sees this click; what keeps it
  // from starting music right after we muted it is the on/off guard in startBackgroundMusic() (sounds.ts).
  const onClick = useCallback((e: MouseEvent) => {
    e.stopPropagation()
    toggle()
  }, [toggle])
  return (
    <button
      type="button"
      data-v2-music-toggle=""
      onClick={onClick}
      data-ts-fab=""
      className={`${FAB} left-5`}
      aria-label={on ? 'Mute sound' : 'Unmute sound'}
      aria-pressed={on}
      title={on ? 'Mute sound' : 'Unmute sound'}
    >
      <MusicSpeaker on={on} />
    </button>
  )
}

/** "?" bottom-right; opens the Help Center drawer. */
export function HelpFab() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      {/* [L-6, A75] Stays mounted (instead of unmounting) while the drawer is open, inert via tabIndex/aria-hidden:
          Sheet's own focus-restore-on-close reads `document.activeElement` at mount and refocuses it later —
          unmounting the opener the instant it is clicked would hand Sheet a dead reference, and restore would
          silently land on <body> instead. */}
      <button
        type="button"
        data-ts-fab=""
        onClick={() => setOpen(true)}
        className={`${FAB} right-5`}
        aria-label="Open help"
        aria-hidden={open || undefined}
        tabIndex={open ? -1 : 0}
      >
        <span aria-hidden="true">?</span>
      </button>
      <HelpDrawer open={open} onClose={close} />
    </>
  )
}
