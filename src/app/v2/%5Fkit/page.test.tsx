// @vitest-environment jsdom
/**
 * [ADR-025] /v2/_kit is a dev/preview-only page: 404 unless VERCEL_ENV === 'preview' or NODE_ENV === 'development'.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

// next/font/local is a build-time (SWC) transform; it cannot run under vitest.
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars' }))

import KitPage from './page'

/** The pinned Round 7 kit matrix: <Primitive>/<variant>/<state>, in page order. */
const KIT_CELLS = [
  'Surface/plain/default', 'Surface/plain/edge-both', 'Surface/sheet/top', 'Surface/sheet/left', 'Surface/strip/bottom',
  'Surface/strip/accent-cream', 'Surface/strip/accent-teal', 'Surface/strip/accent-red', 'Surface/strip/accent-green',
  'Surface/strip/accent-amber', 'Surface/popover/hairline', 'Surface/popover/bare', 'Panel/deprecated/default',
  'Button/primary/enabled', 'Button/primary/disabled', 'Button/text/enabled', 'Button/text/disabled', 'Button/text/danger',
  'Button/text/danger-disabled', 'Button/icon/enabled', 'Button/icon/disabled', 'Button/secondary/deprecated',
  'Tabs/underline/states', 'Segmented/underline/states',
  'Chip/selected', 'Chip/unselected', 'Chip/disabled',
  'Input/field/idle', 'Input/field/invalid', 'Input/field/disabled', 'Input/amount/idle', 'Input/amount/invalid',
  'Toggle/on', 'Toggle/off', 'Toggle/disabled',
  'EyebrowLabel/default', 'HandUnderline/default',
  'Skeleton/line', 'Skeleton/short', 'Skeleton/block',
  'Scrim/left', 'Scrim/left-race', 'Scrim/left-features', 'Scrim/down', 'Scrim/down-features',
]

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

function env(nodeEnv: string, vercelEnv?: string) {
  vi.stubEnv('NODE_ENV', nodeEnv)
  vi.stubEnv('VERCEL_ENV', vercelEnv ?? '')
}

describe('/v2/_kit gating', () => {
  it('production (VERCEL_ENV=production) → 404', () => {
    env('production', 'production')
    expect(() => KitPage()).toThrow('NEXT_NOT_FOUND')
  })

  it('production build with no VERCEL_ENV (self-hosted `next start`) → 404', () => {
    env('production')
    expect(() => KitPage()).toThrow('NEXT_NOT_FOUND')
  })

  it('test env (default NODE_ENV=test) → 404', () => {
    env('test')
    expect(() => KitPage()).toThrow('NEXT_NOT_FOUND')
  })

  it('Vercel preview → renders the kit', () => {
    env('production', 'preview')
    render(KitPage())
    expect(screen.getByRole('heading', { name: /v2 kit/i })).toBeTruthy()
  })

  it('development → renders the kit', () => {
    env('development')
    render(KitPage())
    expect(document.querySelector('[data-ts-ui="v2-kit"]')).not.toBeNull()
  })

  it('shows every primitive and state (the Round 7 matrix, one cell each)', () => {
    env('development')
    render(KitPage())
    const ids = Array.from(document.querySelectorAll('[data-kit-cell]')).map((n) => n.getAttribute('data-kit-cell'))
    expect(ids).toEqual(KIT_CELLS)
    expect(new Set(ids).size).toBe(ids.length)
    expect(screen.getAllByRole('tab')).toHaveLength(6) // Tabs × 3 + Segmented × 3
    expect(screen.getAllByRole('switch')).toHaveLength(3)
    expect(screen.getAllByRole('textbox')).toHaveLength(5)
    expect(document.querySelectorAll('.ts-v2-skeleton')).toHaveLength(3)
    expect(document.querySelectorAll('[data-surface]').length).toBeGreaterThanOrEqual(12)
  })
})
