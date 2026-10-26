/**
 * [ADR-025] The ♫ button's speaker (round-6 `landing/img/music-speaker-{on,off}.svg`; the round-5 copies carried `--`
 * inside an XML comment, which made them invalid). Inline so it needs no request and no XML to parse: stroke 2, round
 * caps and joins, 20 px. On = cream. Off = the same speaker body in `--dim` with a `--muted` slash. Decorative: the
 * button carries the accessible name.
 */
export const MUSIC_SPEAKER_PATHS = {
  body: 'M3 7.5h3L10 4v12l-4-3.5H3z',
  waveNear: 'M13 7.7a3.2 3.2 0 0 1 0 4.6',
  waveFar: 'M15.3 5.4a6.5 6.5 0 0 1 0 9.2',
  slash: 'M2 2l16 16',
} as const

export const MUSIC_ICON_SIZE = 20

export function MusicSpeaker({ on }: { on: boolean }) {
  return (
    <svg
      width={MUSIC_ICON_SIZE}
      height={MUSIC_ICON_SIZE}
      viewBox="0 0 20 20"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-music-icon={on ? 'on' : 'off'}
    >
      {on ? (
        <g style={{ stroke: 'var(--cream, #EADFB6)' }}>
          <path d={MUSIC_SPEAKER_PATHS.body} />
          <path d={MUSIC_SPEAKER_PATHS.waveNear} />
          <path d={MUSIC_SPEAKER_PATHS.waveFar} />
        </g>
      ) : (
        <>
          <path d={MUSIC_SPEAKER_PATHS.body} style={{ stroke: 'var(--dim, #8C887F)' }} />
          <path d={MUSIC_SPEAKER_PATHS.slash} style={{ stroke: 'var(--muted, #A8A498)' }} />
        </>
      )}
    </svg>
  )
}
