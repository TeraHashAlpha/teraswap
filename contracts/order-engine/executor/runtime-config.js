/**
 * runtime-config.js — what the keeper publishes about itself at boot.
 *
 * [ADR-024 scope addition, Architect/owner 2026-10-11] One `keeper_runtime_config` row per chain:
 *   chain_id (PK) · no_price_fill_cap_usd = the EFFECTIVE, ceiling-clamped single-source fill cap ·
 *   keeper_version · updated_at
 * so the web app (28b: GET /api/dca-floor-cap, read-only, service role) can show users the cap this
 * chain's keeper actually enforces instead of a guess. The keeper WRITES this row; the web never
 * does.
 *
 * Pure + injectable (no fetch / env / clock / fs of its own beyond an overridable package.json
 * reader) — same reason every other keeper module is separate from executor.js. NEVER throws and
 * NEVER fatal: a failed write is logged and the boot continues. That explicitly includes the table
 * not existing yet — it is created by the 28b migration
 * (supabase/migrations/20261011120000_orders_floor_tier_consent.sql on feat/dca-floor-tiers-consent,
 * not merged as of 2026-10-11); until it is applied PostgREST answers 404 / PGRST205 and the keeper
 * says exactly that.
 */

import { readFileSync } from "node:fs"
import { redactError } from "./redact.js"

export const RUNTIME_CONFIG_TABLE = "keeper_runtime_config"

/**
 * Build the row, validating every column. Invalid input ⇒ `{ ok: false, reason }` (never throws).
 * @param {{ chainId: number|string, noPriceFillCapUsd: number, keeperVersion: string, nowIso: string }} p
 * @returns {{ ok: true, row: { chain_id: number, no_price_fill_cap_usd: number, keeper_version: string, updated_at: string } } | { ok: false, row: null, reason: string }}
 */
export function buildRuntimeConfigRow({ chainId, noPriceFillCapUsd, keeperVersion, nowIso }) {
  const chain = Number(chainId)
  if (!Number.isInteger(chain) || chain <= 0) return { ok: false, row: null, reason: `invalid chainId '${chainId}'` }
  const cap = Number(noPriceFillCapUsd)
  if (!Number.isFinite(cap) || cap < 0) return { ok: false, row: null, reason: `invalid cap '${noPriceFillCapUsd}'` }
  const version = typeof keeperVersion === "string" && keeperVersion.trim() ? keeperVersion.trim() : null
  if (!version) return { ok: false, row: null, reason: "missing keeperVersion" }
  const ts = typeof nowIso === "string" && !Number.isNaN(Date.parse(nowIso)) ? nowIso : null
  if (!ts) return { ok: false, row: null, reason: `invalid nowIso '${nowIso}'` }
  return { ok: true, row: { chain_id: chain, no_price_fill_cap_usd: cap, keeper_version: version, updated_at: ts } }
}

/**
 * The keeper's version string for the row: `KEEPER_VERSION` env when set, else
 * `<package name>@<package version>` from the executor's own package.json, else a marked unknown.
 * @param {{ env?: object, readFile?: (url: URL) => string }} [p]
 * @returns {string}
 */
export function readKeeperVersion({ env = process.env, readFile = (url) => readFileSync(url, "utf-8") } = {}) {
  const fromEnv = env && env.KEEPER_VERSION ? String(env.KEEPER_VERSION).trim() : ""
  if (fromEnv) return fromEnv
  try {
    const pkg = JSON.parse(readFile(new URL("./package.json", import.meta.url)))
    return `${pkg.name || "teraswap-order-executor"}@${pkg.version || "0.0.0"}`
  } catch {
    return "teraswap-order-executor@unknown"
  }
}

const MISSING_TABLE_RE = /PGRST205|relation .* does not exist|Could not find the table|schema cache/i

/**
 * Upsert the row (PostgREST: POST + `on_conflict=chain_id` + `Prefer: resolution=merge-duplicates`)
 * through the keeper's existing service-role fetch. Every outcome is logged; nothing throws.
 * @param {{ supabaseFetch: (path: string, options?: object) => Promise<Response>, row: object|null, log?: (msg: string) => void }} p
 * @returns {Promise<{ ok: boolean, status: number|null, reason: string, missingTable: boolean }>}
 */
export async function publishRuntimeConfig({ supabaseFetch, row, log = () => {} }) {
  if (!row || typeof row !== "object") {
    log(`  WARNING: ${RUNTIME_CONFIG_TABLE} publish skipped (non-fatal): no row to publish`)
    return { ok: false, status: null, reason: "no row", missingTable: false }
  }
  if (typeof supabaseFetch !== "function") {
    log(`  WARNING: ${RUNTIME_CONFIG_TABLE} publish skipped (non-fatal): no Supabase client`)
    return { ok: false, status: null, reason: "no client", missingTable: false }
  }
  try {
    const res = await supabaseFetch(`${RUNTIME_CONFIG_TABLE}?on_conflict=chain_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    })
    if (res && res.ok) {
      log(
        `  ${RUNTIME_CONFIG_TABLE}: published chain ${row.chain_id} no_price_fill_cap_usd=${row.no_price_fill_cap_usd} ` +
          `keeper_version=${row.keeper_version} updated_at=${row.updated_at}`,
      )
      return { ok: true, status: res.status ?? 200, reason: "published", missingTable: false }
    }
    const status = res && Number.isFinite(res.status) ? res.status : null
    let body = ""
    try {
      body = res && typeof res.text === "function" ? String(await res.text()).slice(0, 200) : ""
    } catch {
      body = ""
    }
    const missingTable = status === 404 || MISSING_TABLE_RE.test(body)
    const reason = missingTable
      ? `table ${RUNTIME_CONFIG_TABLE} is not there yet (HTTP ${status}) — the 28b migration creates it; the web app uses the ceiling until then`
      : `HTTP ${status}${body ? ` ${body}` : ""}`
    log(`  WARNING: ${RUNTIME_CONFIG_TABLE} publish failed (non-fatal): ${reason}`)
    return { ok: false, status, reason, missingTable }
  } catch (err) {
    const msg = redactError(err, { max: 160 }) // [fix/executor-alert-masking-rpc-auth]
    log(`  WARNING: ${RUNTIME_CONFIG_TABLE} publish threw (non-fatal): ${msg}`)
    return { ok: false, status: null, reason: `threw: ${msg}`, missingTable: false }
  }
}

// ── [fix/executor-alert-masking-rpc-auth] The keeper's explicit paused state ─────────────────────
// INC-2026-10-30-001: the provider rejected every RPC call for ~20 h and nothing outside the host
// could tell. The monitor, the daily report and the web app all run OFF the keeper host (which is
// SSM-only), and none of them can reach its /health — Supabase is the one channel they share with
// it. So the state rpc-auth.js reports also lands on this chain's keeper_runtime_config row
// (`paused`, `paused_since` — migration 20261031120000_keeper_runtime_config_paused.sql).

/** Every value `paused` may take (mirrors the migration's CHECK constraint). */
export const PAUSED_VALUES = Object.freeze(["rpc-auth"])
export const PAUSED_MIGRATION = "supabase/migrations/20261031120000_keeper_runtime_config_paused.sql"

const MISSING_COLUMN_RE = /PGRST204|42703|column[^.]*paused|paused[^.]*does not exist|Could not find the 'paused/i

/**
 * Record (`paused` = "rpc-auth") or clear (`paused` = null) the paused state. Setting only touches a
 * row that is NOT already paused (`paused=is.null`), so `paused_since` keeps the FIRST moment across
 * reminders and pm2 restarts; clearing only touches a row that IS paused. A PATCH never creates the
 * row (the boot publish does). Every outcome is logged; nothing throws. Bounded by `timeoutMs`: the
 * boot-refusal path awaits this before process.exit, and a hung Supabase must never turn a refused
 * boot into a process that pm2 shows as "online" and never restarts.
 * @param {{ supabaseFetch: Function, chainId: number|string, paused: string|null, nowIso: string,
 *   log?: (m: string) => void, timeoutMs?: number }} p
 * @returns {Promise<{ ok: boolean, status: number|null, rows: number|null, reason: string, missingColumn: boolean }>}
 */
export async function publishPausedState({ supabaseFetch, chainId, paused, nowIso, log = () => {}, timeoutMs = 5_000 }) {
  const chain = Number(chainId)
  const fail = (reason) => {
    log(`  WARNING: ${RUNTIME_CONFIG_TABLE} paused-state publish skipped (non-fatal): ${reason}`)
    return { ok: false, status: null, rows: null, reason, missingColumn: false }
  }
  if (!Number.isInteger(chain) || chain <= 0) return fail(`invalid chainId '${chainId}'`)
  if (paused !== null && !PAUSED_VALUES.includes(paused)) return fail(`invalid paused '${paused}'`)
  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) return fail(`invalid nowIso '${nowIso}'`)
  if (typeof supabaseFetch !== "function") return fail("no Supabase client")

  const filter = paused ? `chain_id=eq.${chain}&paused=is.null` : `chain_id=eq.${chain}&paused=not.is.null`
  const patch = paused
    ? { paused, paused_since: nowIso, updated_at: nowIso }
    : { paused: null, paused_since: null, updated_at: nowIso }
  try {
    const res = await supabaseFetch(`${RUNTIME_CONFIG_TABLE}?${filter}&select=chain_id`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const status = res && Number.isFinite(res.status) ? res.status : null
    if (res && res.ok) {
      let rows = null
      try {
        const json = await res.json()
        rows = Array.isArray(json) ? json.length : null
      } catch {
        rows = null
      }
      const what = rows === 0 ? "no row changed (already in that state, or no row for this chain yet)" : `${rows ?? "?"} row(s)`
      log(`  ${RUNTIME_CONFIG_TABLE}: chain ${chain} paused=${paused ?? "null"} — ${what}`)
      return { ok: true, status, rows, reason: "published", missingColumn: false }
    }
    let body = ""
    try {
      body = res && typeof res.text === "function" ? String(await res.text()).slice(0, 200) : ""
    } catch {
      body = ""
    }
    const missingColumn = MISSING_COLUMN_RE.test(body)
    const reason = missingColumn
      ? `columns paused/paused_since are not there yet (HTTP ${status}) — apply ${PAUSED_MIGRATION}`
      : `HTTP ${status}${body ? ` ${body}` : ""}`
    log(`  WARNING: ${RUNTIME_CONFIG_TABLE} paused-state publish failed (non-fatal): ${reason}`)
    return { ok: false, status, rows: null, reason, missingColumn }
  } catch (err) {
    const msg = redactError(err, { max: 160 })
    log(`  WARNING: ${RUNTIME_CONFIG_TABLE} paused-state publish threw (non-fatal): ${msg}`)
    return { ok: false, status: null, rows: null, reason: `threw: ${msg}`, missingColumn: false }
  }
}
