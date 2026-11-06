// @vitest-environment jsdom
/** [feat/ui-v2-docs-legal] /v2/terms: same gate as /v2/docs/page.test.tsx. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const h = vi.hoisted(() => ({ version: 'v2' as 'v1' | 'v2' }))
vi.mock('@/ui/v2/version', () => ({ getUiVersion: async () => h.version }))
vi.mock('@/ui/v2/shell/ContentShell', () => ({ ContentShell: ({ page, children }: { page: string; children: React.ReactNode }) => <div data-shell-page={page}>{children}</div> }))
vi.mock('@/ui/v2/shell/ContentPane', () => ({ ContentPane: () => <div data-content-pane="" /> }))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

import V2TermsPage from './page'

afterEach(cleanup)

describe('/v2/terms', () => {
  it('v2 → the shell on the terms page', async () => {
    h.version = 'v2'
    const { container } = render(await V2TermsPage())
    expect(container.querySelector('[data-shell-page="terms"]')).not.toBeNull()
  })

  it('v1 (switch off) → notFound()', async () => {
    h.version = 'v1'
    await expect(V2TermsPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
