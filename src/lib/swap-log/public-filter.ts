/**
 * [ADR-029 decision 7, details D] One server flag, `SWAPS_PUBLIC_VERIFIED_ONLY`, default OFF.
 *
 * OFF (observe mode): every reader of `swaps` asks the database exactly what it asked on main. The server marks rows
 * as it verifies them; nothing a visitor sees changes.
 * ON: every PUBLIC reader counts and lists only rows the server verified on-chain (`verified_at IS NOT NULL`).
 *
 * The wallet's own history (/api/history) is not a public reader: it shows that wallet's pending and failed rows with
 * the flag on or off, and does not use this module.
 *
 * Apply the migration before turning the flag on: a filter on a column that does not exist is a database error.
 */

/** True only for the exact value `true`: anything else, a typo included, leaves the readers as on main. */
export function swapsPublicVerifiedOnly(): boolean {
  return process.env.SWAPS_PUBLIC_VERIFIED_ONLY === 'true'
}

interface NotFilter {
  // The Supabase filter builders all have this method; it returns the builder itself.
  not(column: string, operator: string, value: unknown): unknown
}

/**
 * A public read of `swaps`: with the flag on, only verified rows. With the flag off the query is returned UNTOUCHED
 * (no call is made on it), which is what keeps every reader byte-identical to main.
 * Call it on the filter builder, before `.order()` / `.limit()` / `.range()`.
 */
export function publicSwaps<Q extends NotFilter>(query: Q): Q {
  return swapsPublicVerifiedOnly() ? (query.not('verified_at', 'is', null) as Q) : query
}
