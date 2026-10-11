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
    const msg = String(err?.message ?? err).slice(0, 160)
    log(`  WARNING: ${RUNTIME_CONFIG_TABLE} publish threw (non-fatal): ${msg}`)
    return { ok: false, status: null, reason: `threw: ${msg}`, missingTable: false }
  }
}
