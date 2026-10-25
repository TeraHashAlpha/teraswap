// @vitest-environment jsdom
/**
 * [ADR-025] /v2 route: defence in depth behind proxy.ts — renders v2 only when the switch says v2.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const h = vi.hoisted(() => ({ version: 'v1' as 'v1' | 'v2' }))
vi.mock('@/ui/v2/version', () => ({ getUiVersion: async () => h.version }))
// next/font/local is a build-time (SWC) transform; it cannot run under vitest.
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars' }))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

import V2Home from './page'

afterEach(cleanup)

describe('/v2 page', () => {
  it('v1 → notFound() (never renders the v2 tree)', async () => {
    h.version = 'v1'
    await expect(V2Home()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('v2 → renders the v2 home', async () => {
    h.version = 'v2'
    render(await V2Home())
    expect(document.querySelector('[data-ts-ui="v2"]')).not.toBeNull()
  })
})
