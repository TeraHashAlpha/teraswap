/**
 * [P115/M-01] Custom render wrapper for component tests.
 *
 * @testing-library/react's render() doesn't know about our providers;
 * this wraps with the minimum needed for component tests to mount
 * (ToastProvider). WagmiConfig is intentionally NOT wired in here —
 * we mock the wagmi hooks at the import boundary instead of standing
 * up a real provider, because the real one needs RPC + Connector
 * config and bloats every test boot.
 *
 * Tests that need toast or theme can use this; others can use
 * @testing-library/react's render directly.
 */

import type { ReactElement, ReactNode } from 'react'
import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import { ToastProvider } from '@/components/ToastProvider'

interface Wrappers {
  /** When true (default), wraps in ToastProvider. */
  toast?: boolean
}

function AllProviders({
  children,
  toast = true,
}: { children: ReactNode } & Wrappers) {
  if (!toast) return <>{children}</>
  return <ToastProvider>{children}</ToastProvider>
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderOptions & Wrappers = {},
): RenderResult {
  const { toast = true, ...rest } = options
  return render(ui, {
    wrapper: ({ children }) => <AllProviders toast={toast}>{children}</AllProviders>,
    ...rest,
  })
}

// Re-export the standard hooks for convenience.
export * from '@testing-library/react'
