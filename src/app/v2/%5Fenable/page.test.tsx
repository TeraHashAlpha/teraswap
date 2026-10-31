// @vitest-environment jsdom
/**
 * [ADR-025] /v2/_enable is a preview/dev-only page: 404 unless VERCEL_ENV === 'preview' or NODE_ENV === 'development'
 * (same gate as /v2/_kit), and its form POSTs the admin secret to the existing /api/admin/ui-version.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
// next/font/local is a build-time (SWC) transform; it cannot run under vitest.
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars' }))

import EnablePage from './page'
import EnableForm, { enableErrorMessage } from './enable-form'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function env(nodeEnv: string, vercelEnv?: string) {
  vi.stubEnv('NODE_ENV', nodeEnv)
  vi.stubEnv('VERCEL_ENV', vercelEnv ?? '')
}

describe('/v2/_enable gating', () => {
  it.each([
    ['production', 'production'],
    ['production', ''],
    ['test', ''],
  ])('NODE_ENV=%s VERCEL_ENV=%s → 404', (nodeEnv, vercelEnv) => {
    env(nodeEnv, vercelEnv)
    expect(() => EnablePage()).toThrow('NEXT_NOT_FOUND')
  })

  it.each([
    ['production', 'preview'],
    ['development', ''],
  ])('NODE_ENV=%s VERCEL_ENV=%s → the form', (nodeEnv, vercelEnv) => {
    env(nodeEnv, vercelEnv)
    render(EnablePage())
    expect(screen.getByLabelText('Admin secret')).toBeTruthy()
  })
})

describe('the form', () => {
  function submit(secret: string) {
    fireEvent.change(screen.getByLabelText('Admin secret'), { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable v2' }))
  }

  it('POSTs {version:"v2"} with the secret as a Bearer token to the existing admin route, same-origin', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const redirect = vi.fn()
    render(<EnableForm redirect={redirect} />)
    submit('s3cret')
    await waitFor(() => expect(redirect).toHaveBeenCalledWith('/'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/admin/ui-version')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer s3cret')
    expect(init.body).toBe('{"version":"v2"}')
  })

  it('wrong secret (401): says so, never redirects, clears the field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })))
    const redirect = vi.fn()
    render(<EnableForm redirect={redirect} />)
    submit('nope')
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong secret.')
    expect(redirect).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Admin secret') as HTMLInputElement).value).toBe('')
  })

  it('the secret is a password field, never put in the URL or storage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    render(<EnableForm redirect={vi.fn()} />)
    expect(screen.getByLabelText('Admin secret').getAttribute('type')).toBe('password')
    submit('abc-secret-123')
    await screen.findByRole('alert')
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('abc-secret-123')
    expect(window.location.href).not.toContain('abc-secret-123')
  })

  it('503 / network failure show their own message and set nothing', async () => {
    expect(enableErrorMessage(503)).toMatch(/not configured/)
    expect(enableErrorMessage(500)).toBe('Could not enable v2 (HTTP 500).')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    const redirect = vi.fn()
    render(<EnableForm redirect={redirect} />)
    submit('x')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Network error/)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('an empty secret cannot be submitted', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<EnableForm redirect={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Enable v2' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
