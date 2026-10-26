// @vitest-environment jsdom
/**
 * [ADR-025] HomeV2 = v1's landing-vs-app split (src/app/page.tsx: `useState<AppPage>('landing')`, `setPage('swap')`
 * on every Launch CTA, logo → `setPage('landing')`). The two halves are mocked here; each has its own suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('./landing', () => ({
  LandingV2: ({ onLaunchApp }: { onLaunchApp: () => void }) => (
    <div data-testid="landing">
      <button onClick={onLaunchApp}>Launch app</button>
    </div>
  ),
}))
vi.mock('./shell', () => ({
  AppShell: ({ tab, onLogoClick }: { tab: string; onLogoClick?: () => void }) => (
    <div data-testid="app" data-tab={tab}>
      <button onClick={onLogoClick}>logo</button>
    </div>
  ),
}))

import HomeV2 from './HomeV2'

afterEach(cleanup)

describe('HomeV2', () => {
  it('a visitor without app state sees the landing, not the app', () => {
    render(<HomeV2 />)
    expect(screen.getByTestId('landing')).toBeTruthy()
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('a Launch CTA opens the app on the Swap tab (v1: setPage("swap"))', () => {
    render(<HomeV2 />)
    fireEvent.click(screen.getByRole('button', { name: 'Launch app' }))
    expect(screen.getByTestId('app').getAttribute('data-tab')).toBe('swap')
    expect(screen.queryByTestId('landing')).toBeNull()
  })

  it('the logo goes back to the landing (v1: onLogoClick → setPage("landing"))', () => {
    render(<HomeV2 />)
    fireEvent.click(screen.getByRole('button', { name: 'Launch app' }))
    fireEvent.click(screen.getByRole('button', { name: 'logo' }))
    expect(screen.getByTestId('landing')).toBeTruthy()
  })

  it('app state is in-memory only: a fresh mount is the landing again', () => {
    const first = render(<HomeV2 />)
    fireEvent.click(screen.getByRole('button', { name: 'Launch app' }))
    first.unmount()
    render(<HomeV2 />)
    expect(screen.getByTestId('landing')).toBeTruthy()
  })
})
