/**
 * DCA circuit-breaker freeze state — shared by the create-order API and the
 * admin freeze route (NOT the keeper; executor.js reads the same table via
 * its own REST helper).
 *
 * Backed by the Supabase `circuit_breaker` table, single fixed row id='dca':
 *   id text primary key, frozen boolean not null default false, reason text,
 *   updated_at timestamptz not null default now(), updated_by text
 *
 * FAIL-OPEN POLICY: the table may not exist yet in prod. Readers MUST treat
 * "no Supabase client / no row / table missing / any read error" as NOT
 * frozen. The on-chain pause() is the nuclear fail-safe — the application
 * layer must never block legitimate orders just because the breaker table is
 * unreachable. Writers upsert id='dca'.
 */

import { getSupabase } from '@/lib/supabase'

const TABLE = 'circuit_breaker'
const ROW_ID = 'dca'

export interface DcaFreezeState {
  frozen: boolean
  reason: string | null
  updatedAt: string | null
  updatedBy: string | null
}

/** The fail-open default — returned whenever the breaker state can't be read. */
const NOT_FROZEN: DcaFreezeState = {
  frozen: false,
  reason: null,
  updatedAt: null,
  updatedBy: null,
}

interface CircuitBreakerRow {
  frozen: boolean | null
  reason: string | null
  updated_at: string | null
  updated_by: string | null
}

/**
 * Read the DCA freeze flag. Never throws.
 *
 * Returns NOT_FROZEN when Supabase is unconfigured, when the row is missing
 * (maybeSingle → null), or when any error is raised (table missing, network,
 * etc.). This is the deliberate fail-open contract described above.
 */
export async function getDcaFreezeState(): Promise<DcaFreezeState> {
  const sb = getSupabase()
  if (!sb) return { ...NOT_FROZEN }

  try {
    const { data, error } = await sb
      .from(TABLE)
      .select('frozen,reason,updated_at,updated_by')
      .eq('id', ROW_ID)
      .maybeSingle()

    if (error) {
      console.error('[dca-freeze] read error:', error.message)
      return { ...NOT_FROZEN }
    }

    const row = (data as CircuitBreakerRow | null) ?? null
    if (!row) return { ...NOT_FROZEN }

    return {
      frozen: row.frozen === true,
      reason: row.reason ?? null,
      updatedAt: row.updated_at ?? null,
      updatedBy: row.updated_by ?? null,
    }
  } catch (err) {
    console.error(
      '[dca-freeze] read threw:',
      err instanceof Error ? err.message : err,
    )
    return { ...NOT_FROZEN }
  }
}

/**
 * Set the DCA freeze flag (upsert the fixed id='dca' row) and return the new
 * state. Used by the admin freeze route after Bearer auth.
 */
export async function setDcaFreezeState(
  frozen: boolean,
  reason: string,
  updatedBy: string,
): Promise<DcaFreezeState> {
  const sb = getSupabase()
  const updatedAt = new Date().toISOString()

  const newState: DcaFreezeState = {
    frozen,
    reason,
    updatedAt,
    updatedBy,
  }

  if (!sb) {
    // Unconfigured backend — nothing to persist. Surface the requested state
    // so callers get a consistent shape; the keeper's on-chain pause() remains
    // the real safety net.
    console.error('[dca-freeze] setDcaFreezeState: Supabase unconfigured')
    return newState
  }

  const { error } = await sb.from(TABLE).upsert({
    id: ROW_ID,
    frozen,
    reason,
    updated_by: updatedBy,
    updated_at: updatedAt,
  })

  if (error) {
    console.error('[dca-freeze] write error:', error.message)
    throw new Error(`Failed to set DCA freeze state: ${error.message}`)
  }

  return newState
}
