/**
 * [feat/ui-v2-fiat-value] The visitor's currency choice (dollars or euros). Stored in localStorage, defaults to dollars, and read through
 * `useSyncExternalStore` so every line that shows a fiat figure switches together and the server render is always dollars (no hydration
 * mismatch). Storage can be absent or throw (private window, blocked site data): the choice then lives for the page only.
 */
import { useSyncExternalStore } from 'react'
import type { FiatCurrency } from './fiat-format'

export const FIAT_CURRENCY_KEY = 'teraswap:v2:fiat-currency'
export const DEFAULT_FIAT_CURRENCY: FiatCurrency = 'USD'

let memory: FiatCurrency | null = null
const listeners = new Set<() => void>()

function read(): FiatCurrency {
  if (memory !== null) return memory
  try {
    const v = localStorage.getItem(FIAT_CURRENCY_KEY)
    if (v === 'USD' || v === 'EUR') return v
  } catch {
    /* no storage: the default */
  }
  return DEFAULT_FIAT_CURRENCY
}

export function getFiatCurrency(): FiatCurrency {
  return read()
}

export function setFiatCurrency(next: FiatCurrency): void {
  memory = next
  try {
    localStorage.setItem(FIAT_CURRENCY_KEY, next)
  } catch {
    /* page-only */
  }
  listeners.forEach((l) => l())
}

/** Test-only: forget the in-page choice so the next read goes to storage again. */
export function _resetFiatPreference(): void {
  memory = null
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  // Another tab changed the choice.
  const onStorage = (e: StorageEvent) => {
    if (e.key === FIAT_CURRENCY_KEY) {
      memory = null
      cb()
    }
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** The stored choice (what the switch shows). The currency actually USED is `useFiatDisplay().currency`: a EUR choice falls back to dollars while the rate is unavailable. */
export function useFiatPreference(): FiatCurrency {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_FIAT_CURRENCY)
}
