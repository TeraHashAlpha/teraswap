// @vitest-environment jsdom
/**
 * [feat/ui-v2-docs-legal] /v2/docs: renders the shell only when the switch says v2; otherwise notFound() — same
 * defence-in-depth as /v2/[tab]/page.test.tsx (proxy.ts already 404s a direct hit; this is UI only).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const h = vi.hoisted(() => ({ version: 'v2' as 'v1' | 'v2' }))
vi.mock('@/ui/v2/version', () => ({ getUiVersion: async () => h.version }))
vi.mock('@/ui/v2/shell/ContentShell', () => ({ ContentShell: ({ page, children }: { page: string; children: React.ReactNode }) => <div data-shell-page={page}>{children}</div> }))
vi.mock('@/ui/v2/docs-legal/DocsTabV2', () => ({ DocsTabV2: () => <div data-docs-tab="" /> }))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

import V2DocsPage from './page'

afterEach(cleanup)

describe('/v2/docs', () => {
  it('v2 → the shell on the docs page', async () => {
    h.version = 'v2'
    const { container } = render(await V2DocsPage())
    expect(container.querySelector('[data-shell-page="docs"]')).not.toBeNull()
    expect(container.querySelector('[data-docs-tab]')).not.toBeNull()
  })

  it('v1 (switch off) → notFound(), never the shell', async () => {
    h.version = 'v1'
    await expect(V2DocsPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
