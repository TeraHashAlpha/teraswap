/**
 * Source preferences: user can enable/disable specific aggregator sources.
 * Stored in localStorage for persistence across sessions.
 */

import { AGGREGATOR_META, type AggregatorName } from '@/lib/constants'

const STORAGE_KEY = 'teraswap_source_prefs'

export type SourcePreferences = Record<AggregatorName, boolean>

/** Get all source names from AGGREGATOR_META */
export function getAllSources(): AggregatorName[] {
  return Object.keys(AGGREGATOR_META) as AggregatorName[]
}

/** Load preferences from localStorage (all enabled by default) */
export function loadSourcePreferences(): SourcePreferences {
  const defaults: SourcePreferences = {} as SourcePreferences
  for (const source of getAllSources()) {
    defaults[source] = true
  }

  if (typeof window === 'undefined') return defaults

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return defaults
    const parsed = JSON.parse(stored) as Partial<SourcePreferences>
    // Merge: stored values override defaults, new sources default to enabled
    return { ...defaults, ...parsed }
  } catch {
    return defaults
  }
}

/** Save preferences to localStorage */
export function saveSourcePreferences(prefs: SourcePreferences): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // silently ignore
  }
}

/** Get the list of enabled source names */
export function getEnabledSources(prefs: SourcePreferences): AggregatorName[] {
  return getAllSources().filter(s => prefs[s])
}

/** Toggle a single source and return updated preferences */
export function toggleSource(prefs: SourcePreferences, source: AggregatorName): SourcePreferences {
  const updated = { ...prefs, [source]: !prefs[source] }
  // Ensure at least 1 source remains enabled
  const enabledCount = Object.values(updated).filter(Boolean).length
  if (enabledCount === 0) return prefs // Don't allow disabling all
  saveSourcePreferences(updated)
  return updated
}
