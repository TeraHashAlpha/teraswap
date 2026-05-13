/**
 * [P115/M-01] Global vitest setup.
 *
 * Runs once per test process, before any test file. Jobs:
 *   1. Wire @testing-library/jest-dom into vitest's `expect` so DOM
 *      matchers like toBeInTheDocument()/toHaveTextContent() exist.
 *      Without this, .tsx component tests have to fall back to raw
 *      DOM assertions.
 *   2. After each test, clear any rendered DOM so the next test starts
 *      from a clean state (jsdom env only — no-op for node-env tests).
 *   3. Install a minimal in-memory localStorage when the env's
 *      `localStorage` is missing or stubbed as a plain {} — jsdom 29
 *      ships a non-Storage object in some configurations and that
 *      breaks any production code that calls .getItem/.clear.
 *
 * Kept thin. Anything heavier belongs in a per-file beforeEach so the
 * cost is opt-in rather than paid by every node-env test.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// `cleanup` is a no-op when there's nothing rendered (node-env tests).
afterEach(() => cleanup())

// jsdom 29 doesn't always wire a real Storage instance on localStorage
// — install a minimal polyfill so production code's
// `localStorage.getItem / .setItem / .removeItem / .clear` all work.
function installStoragePolyfill(): void {
  const g = globalThis as unknown as { localStorage?: unknown; sessionStorage?: unknown }
  if (typeof g.localStorage === 'object' && g.localStorage !== null && typeof (g.localStorage as Storage).getItem === 'function') {
    return // already a working Storage
  }
  const make = (): Storage => {
    let store: Record<string, string> = {}
    return {
      get length() { return Object.keys(store).length },
      key: (i: number) => Object.keys(store)[i] ?? null,
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v) },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
    }
  }
  g.localStorage = make()
  g.sessionStorage = make()
}
installStoragePolyfill()
