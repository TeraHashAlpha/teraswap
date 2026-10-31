// @vitest-environment jsdom
/**
 * [ADR-025] The ♫ speaker icons (round-6 music-speaker-{on,off}.svg, inlined): 20 px, stroke 2, round caps, the pack's
 * paths and token colours, both states, and well-formed XML (the round-5 files were not).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MUSIC_SPEAKER_PATHS, MUSIC_ICON_SIZE, MusicSpeaker } from './MusicSpeaker'

afterEach(cleanup)

const svg = (on: boolean) => render(<MusicSpeaker on={on} />).container.querySelector('svg')!

describe('MusicSpeaker', () => {
  it.each([true, false])('on=%s: a 20 × 20 viewBox-20 stroke-2 round-cap icon, decorative', (on) => {
    const el = svg(on)
    expect(MUSIC_ICON_SIZE).toBe(20)
    expect(el.getAttribute('width')).toBe('20')
    expect(el.getAttribute('height')).toBe('20')
    expect(el.getAttribute('viewBox')).toBe('0 0 20 20')
    expect(el.getAttribute('fill')).toBe('none')
    expect(el.getAttribute('stroke-width')).toBe('2')
    expect(el.getAttribute('stroke-linecap')).toBe('round')
    expect(el.getAttribute('stroke-linejoin')).toBe('round')
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.getAttribute('data-music-icon')).toBe(on ? 'on' : 'off')
  })

  it('on: the speaker body and both sound waves, in cream', () => {
    const el = svg(true)
    expect(Array.from(el.querySelectorAll('path')).map((p) => p.getAttribute('d'))).toEqual([
      'M3 7.5h3L10 4v12l-4-3.5H3z',
      'M13 7.7a3.2 3.2 0 0 1 0 4.6',
      'M15.3 5.4a6.5 6.5 0 0 1 0 9.2',
    ])
    expect((el.querySelector('g') as SVGGElement).style.stroke).toContain('var(--cream')
    expect(el.querySelector('path[d="M2 2l16 16"]')).toBeNull() // no slash while the music plays
  })

  it('off: the same body in --dim with a --muted slash, and no waves', () => {
    const el = svg(false)
    const [body, slash] = Array.from(el.querySelectorAll('path'))
    expect(body.getAttribute('d')).toBe(MUSIC_SPEAKER_PATHS.body)
    expect(slash.getAttribute('d')).toBe('M2 2l16 16')
    expect(body.style.stroke).toContain('var(--dim')
    expect(slash.style.stroke).toContain('var(--muted')
    expect(el.querySelectorAll('path')).toHaveLength(2)
  })

  it.each([true, false])('on=%s serialises to well-formed XML (the round-5 files had `--` in a comment)', (on) => {
    const xml = new XMLSerializer().serializeToString(svg(on))
    const doc = new DOMParser().parseFromString(xml, 'image/svg+xml')
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(xml).not.toContain('<!--')
  })
})

describe('the ♫ button uses them', () => {
  it('Fabs renders the on icon while the music plays and the off icon once toggled', async () => {
    vi.resetModules()
    vi.doMock('./../shell/HelpDrawer', () => ({ HelpDrawer: () => null }))
    vi.doMock('@/lib/sounds', () => ({ startBackgroundMusic: vi.fn(), toggleBackgroundMusic: vi.fn(() => false) }))
    const { MusicToggle } = await import('../shell/Fabs')
    const { fireEvent } = await import('@testing-library/react')
    render(<MusicToggle />)
    const button = screen.getByRole('button', { name: 'Turn music off' })
    expect(button.querySelector('svg')!.getAttribute('data-music-icon')).toBe('on')
    expect(button.textContent).toBe('') // no glyph left
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Turn music on' }).querySelector('svg')!.getAttribute('data-music-icon')).toBe('off')
    vi.doUnmock('@/lib/sounds')
    vi.doUnmock('./../shell/HelpDrawer')
  })
})
