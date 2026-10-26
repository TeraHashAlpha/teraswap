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

  it('shows every primitive and state', () => {
    env('development')
    render(KitPage())
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[]
    expect(buttons).toHaveLength(4) // primary/secondary × enabled/disabled
    expect(buttons.filter((b) => b.disabled)).toHaveLength(2)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(document.querySelectorAll('.ts-v2-skeleton').length).toBeGreaterThanOrEqual(3)
    expect(document.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
  })
})
