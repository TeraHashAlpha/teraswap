'use client'

import { useState, type FormEvent } from 'react'
import '@/ui/v2/v2.css'
import { v2FontClassNames } from '@/ui/v2/font-loader'
import { Button, Panel } from '@/ui/v2/primitives'

/** What the admin route answers, in words. Anything but 200 sets no cookie (the route sets it only on success). */
export function enableErrorMessage(status: number): string {
  if (status === 401) return 'Wrong secret.'
  if (status === 503) return 'The UI switch is not configured on this deployment.'
  return `Could not enable v2 (HTTP ${status}).`
}

/**
 * [ADR-025] POSTs the admin secret to the existing /api/admin/ui-version (Bearer, same-origin) so the browser receives
 * the signed `ts_ui` cookie, then goes to `/`. The secret lives in this component's state only: never stored, never put
 * in a URL, cleared after the request.
 */
export default function EnableForm({ redirect = (to: string) => window.location.assign(to) }: { redirect?: (to: string) => void }) {
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy || !secret) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/ui-version', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ version: 'v2' }),
        credentials: 'same-origin',
      })
      if (res.ok) {
        setSecret('')
        redirect('/')
        return
      }
      setError(enableErrorMessage(res.status))
    } catch {
      setError('Network error — nothing was changed.')
    } finally {
      setSecret('')
      setBusy(false)
    }
  }

  return (
    <main data-ts-ui="v2" className={`ts-v2 flex min-h-screen items-center justify-center px-4 ${v2FontClassNames}`}>
      <Panel className="w-full max-w-[420px] p-6">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <h1 className="font-v2-display text-3xl uppercase text-v2-text">Enable v2</h1>
          <p className="text-sm text-v2-muted">Preview only. Sets the signed UI cookie in this browser, then opens the site.</p>
          <label className="flex flex-col gap-1.5 text-sm text-v2-muted">
            Admin secret
            <input
              type="password"
              name="secret"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(ev) => setSecret(ev.target.value)}
              className="h-11 rounded-v2-control border border-v2-border bg-v2-bg px-3 font-v2-mono text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-teal"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-v2-red">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={busy || !secret}>
            Enable v2
          </Button>
        </form>
      </Panel>
    </main>
  )
}
