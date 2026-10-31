/**
 * [fix/executor-alert-masking-rpc-auth] RPC auth/allowlist rejection is FATAL-OPS, not transient.
 *
 * INC-2026-10-30-001: an Alchemy domain allowlist was put on the key inside the Base keeper's RPC_URL.
 * From then on every RPC call was refused ("Unspecified origin not on whitelist."), and for ~20 h the
 * keeper treated that exactly like a flaky network: the event watcher logged "Poll error (5/5)" in a
 * loop, the balance read flipped rpcDown, and nothing said "your credentials are rejected". A
 * transient error heals by itself; this one never does — it needs a human to fix the key or the
 * allowlist, so it gets its own classification, its own alert and an explicit state.
 *
 * WHAT COUNTS AS AUTH (classifyRpcError walks the error and its .cause chain, viem-shaped or not):
 *   - an HTTP 401 / 403 status (viem HttpRequestError — a non-JSON body: "Must be authenticated!",
 *     a provider/WAF 403 page);
 *   - the provider's own words, matched on REDACTED text (so a key or path can never match): "not on
 *     whitelist" (Alchemy allowlist), "must be authenticated", "invalid api key", "api key …
 *     invalid/disabled/…", "invalid project id", "unauthorized". These matter because a 403 WITH a
 *     JSON-RPC body is re-thrown by viem as a generic -32600/-32000 RPC error and the HTTP status is
 *     gone — measured against viem 2.47.10, pinned in rpc-auth.test.mjs.
 * NEVER auth: a contract revert ("execution reverted", ContractFunctionRevertedError) — a revert
 * reason that happens to say "not on whitelist" is the contract talking, not the provider.
 * Everything else (timeouts, 429, 5xx, ECONNREFUSED) stays TRANSIENT and keeps today's handling.
 *
 * RUNTIME (createRpcAuthMonitor): every RPC outcome the keeper already observes is reported to ONE
 * per-process monitor. RPC_AUTH_THRESHOLD consecutive auth errors (a success resets the streak; a
 * transient error neither counts nor resets) ⇒ state `paused: rpc-auth`, ONE high-urgency alert, a
 * reminder at most once per RPC_AUTH_ALERT_COOLDOWN_MS with the suppressed count, and ONE recovery
 * alert on the first success. The state is REPORTED (health, metrics, keeper_runtime_config); it is
 * not a new gate — with every RPC call refused nothing can execute anyway, and the keeper keeps
 * polling so it recovers by itself the moment the key works again.
 *
 * BOOT (createBootAlertGate): chain-verify fails closed as before; executor.js prints
 * `rpc: AUTH REJECTED chain=<id> source=RPC_URL — check provider allowlist/key` and alerts. pm2
 * restarts a failed boot every 5 s up to 50 times, so the boot alert is rate-limited ACROSS processes
 * through a small state file in os.tmpdir() (per chain). If that file cannot be read or written the
 * alert is SENT — failing to rate-limit must never mean failing to alert.
 *
 * Pure apart from the gate's file I/O (injectable); no env reads, no network.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { redactUrl } from "./redact.js"

export const RPC_AUTH = "auth"
export const RPC_TRANSIENT = "transient"
/** The `paused` value reported while the provider rejects the keeper's credentials. */
export const PAUSED_RPC_AUTH = "rpc-auth"

/** Consecutive auth errors before the state flips — small: an auth rejection does not heal. */
export const RPC_AUTH_THRESHOLD = 3
/** Reminder interval while the rejection persists (same cadence as the low-gas alert). */
export const RPC_AUTH_ALERT_COOLDOWN_MS = 3_600_000

const AUTH_STATUS = new Set([401, 403])
/** [label, pattern] — matched on lower-cased, URL-redacted error text. */
const AUTH_TEXT = [
  ["not on whitelist", /not on (?:the )?whitelist/],
  ["must be authenticated", /must be authenticated/],
  ["invalid api key", /invalid api[ _-]?key/],
  ["api key rejected", /api[ _-]?key (?:is )?(?:invalid|disabled|revoked|expired|missing|not found|not valid)/],
  ["invalid project id", /invalid project[ _-]?id/],
  ["unauthorized", /\bunauthori[sz]ed\b/],
]
const REVERT_TEXT = /execution reverted/

/** Flatten an error + its .cause chain: statuses, names, text. Never throws; cycle-safe. */
function walk(err) {
  const statuses = []
  const names = []
  const parts = []
  const seen = new Set()
  let e = err
  for (let depth = 0; e != null && depth < 10; depth++) {
    if (typeof e !== "object") {
      parts.push(String(e))
      break
    }
    if (seen.has(e)) break
    seen.add(e)
    if (typeof e.status === "number") statuses.push(e.status)
    if (typeof e.name === "string") names.push(e.name)
    for (const k of ["shortMessage", "message", "details", "reason"]) if (typeof e[k] === "string") parts.push(e[k])
    if (Array.isArray(e.metaMessages)) for (const m of e.metaMessages) if (typeof m === "string") parts.push(m)
    e = e.cause
  }
  return { statuses, names, text: redactUrl(parts.join(" \n ")).toLowerCase() }
}

/**
 * @param {unknown} err
 * @returns {{ kind: 'auth'|'transient', signal: string|null }} signal = a short, secret-free label
 *   for the alert ("HTTP 403", "not on whitelist", …); null when transient
 */
export function classifyRpcError(err) {
  try {
    const { statuses, names, text } = walk(err)
    const status = statuses.find((s) => AUTH_STATUS.has(s))
    if (status !== undefined) return { kind: RPC_AUTH, signal: `HTTP ${status}` }
    if (names.includes("ContractFunctionRevertedError") || REVERT_TEXT.test(text)) return { kind: RPC_TRANSIENT, signal: null }
    for (const [label, re] of AUTH_TEXT) if (re.test(text)) return { kind: RPC_AUTH, signal: label }
  } catch {
    /* an unclassifiable error is treated like today: transient */
  }
  return { kind: RPC_TRANSIENT, signal: null }
}

/**
 * The keeper's single runtime auth tracker (one process = one chain).
 * @param {object} o
 * @param {number|string} o.chainId
 * @param {string} [o.source] — the env var naming the endpoint (never its value)
 * @param {(p: object) => Promise<unknown>} o.alert — alert.js alertRpcAuth in production
 * @param {(state: object) => Promise<unknown>|unknown} [o.onStateChange] — called on pause and on clear
 * @param {(msg: string) => void} [o.log]
 * @returns {{ onRpcError: (origin: string, err: unknown) => Promise<{kind: string, signal: string|null, alerted: boolean}>,
 *   onRpcSuccess: (origin: string) => Promise<{recovered: boolean}>, state: () => object }}
 */
export function createRpcAuthMonitor({
  chainId,
  source = "RPC_URL",
  threshold = RPC_AUTH_THRESHOLD,
  cooldownMs = RPC_AUTH_ALERT_COOLDOWN_MS,
  now = Date.now,
  alert,
  onStateChange = () => {},
  log = () => {},
} = {}) {
  let consecutive = 0
  let pausedSince = null
  let lastAlertAt = 0
  let suppressed = 0
  let lastSignal = null
  let lastOrigin = null

  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())
  const state = () => ({
    paused: pausedSince == null ? null : PAUSED_RPC_AUTH,
    pausedSince: iso(pausedSince),
    consecutiveAuthErrors: consecutive,
    threshold,
    source,
    lastSignal,
    lastOrigin,
  })
  const safely = async (fn) => {
    try {
      await fn()
    } catch {
      /* alerting/reporting must never break the poll or the cycle that reported */
    }
  }

  async function onRpcError(origin, err) {
    const { kind, signal } = classifyRpcError(err)
    if (kind !== RPC_AUTH) return { kind, signal, alerted: false }
    consecutive += 1
    lastSignal = signal
    lastOrigin = origin
    if (consecutive < threshold) return { kind, signal, alerted: false }

    const t = now()
    const base = { chainId, source, signal, consecutive, threshold, origin }
    if (pausedSince == null) {
      pausedSince = t // set before any await: a concurrent report sees the pause and is rate-limited
      lastAlertAt = t
      suppressed = 0
      log(`rpc: AUTH REJECTED chain=${chainId} source=${source} — check provider allowlist/key`)
      log(`   paused: ${PAUSED_RPC_AUTH} after ${consecutive} consecutive auth errors (last: ${origin}, ${signal})`)
      await safely(() => onStateChange(state()))
      await safely(() => alert({ ...base, phase: "runtime", since: iso(pausedSince), suppressed: 0 }))
      return { kind, signal, alerted: true }
    }
    if (t - lastAlertAt >= cooldownMs) {
      const n = suppressed
      lastAlertAt = t
      suppressed = 0
      await safely(() => alert({ ...base, phase: "runtime", since: iso(pausedSince), suppressed: n }))
      return { kind, signal, alerted: true }
    }
    suppressed += 1
    return { kind, signal, alerted: false }
  }

  async function onRpcSuccess(origin) {
    consecutive = 0
    if (pausedSince == null) return { recovered: false }
    const since = iso(pausedSince)
    const n = suppressed
    pausedSince = null
    lastAlertAt = 0
    suppressed = 0
    log(`rpc: auth recovered chain=${chainId} source=${source} (${origin}) — paused: ${PAUSED_RPC_AUTH} cleared`)
    await safely(() => onStateChange(state()))
    await safely(() => alert({ chainId, source, phase: "recovered", since, suppressed: n, origin }))
    return { recovered: true }
  }

  return { onRpcError, onRpcSuccess, state }
}

/**
 * Cross-process rate limit for the BOOT auth alert (pm2 restarts a refused boot every few seconds).
 * @param {{ chainId: number|string, cooldownMs?: number, now?: () => number, file?: string,
 *   read?: (f: string) => string, write?: (f: string, s: string) => void }} o
 * @returns {{ check: () => { send: boolean, suppressed: number, lastSentAt: string|null } }}
 */
export function createBootAlertGate({
  chainId,
  cooldownMs = RPC_AUTH_ALERT_COOLDOWN_MS,
  now = Date.now,
  file = join(tmpdir(), `teraswap-keeper-rpc-auth-boot-${chainId}.json`),
  read = (f) => readFileSync(f, "utf-8"),
  write = (f, s) => writeFileSync(f, s, { mode: 0o600 }),
} = {}) {
  return {
    check() {
      const t = now()
      let prev = null
      try {
        const parsed = JSON.parse(read(file))
        if (parsed && Number.isFinite(parsed.lastSentAt)) prev = parsed
      } catch {
        prev = null // missing / unreadable / corrupt ⇒ behave as "never sent"
      }
      const send = prev == null || t - prev.lastSentAt >= cooldownMs
      const suppressed = prev == null ? 0 : Number(prev.suppressed) || 0
      const next = send ? { lastSentAt: t, suppressed: 0 } : { lastSentAt: prev.lastSentAt, suppressed: suppressed + 1 }
      try {
        write(file, JSON.stringify(next))
      } catch {
        /* cannot persist ⇒ the next boot alerts again: louder, never quieter */
      }
      return {
        send,
        suppressed: send ? suppressed : suppressed + 1,
        lastSentAt: prev ? new Date(prev.lastSentAt).toISOString() : null,
      }
    },
  }
}
