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
 *   - [A71 L-2] ANY OTHER HTTP status (429, 5xx, a proxy page) is TRANSIENT, full stop: its body is
 *     not matched, so a 503 page that says "unauthorized upstream" is not a rejected key;
 *   - with NO HTTP status, the provider's own words, matched on REDACTED text (so a key or path can
 *     never match): "not on whitelist" (Alchemy allowlist), "must be authenticated", "invalid api key", "api key …
 *     invalid/disabled/…", "invalid project id", "unauthorized". These matter because a 403 WITH a
 *     JSON-RPC body is re-thrown by viem as a generic -32600/-32000 RPC error and the HTTP status is
 *     gone — measured against viem 2.47.10, pinned in rpc-auth.test.mjs.
 * NEVER auth: a contract revert ("execution reverted", ContractFunctionRevertedError) — a revert
 * reason that happens to say "not on whitelist" is the contract talking, not the provider.
 * [A73d L-2] …but a ContractFunctionRevertedError is a revert only when something proves one: viem's
 * getContractError wraps ANY JSON-RPC -32603 (InternalRpcError) in that name — a guess, no contract code
 * ran — so a -32603 whose body carries the provider's auth words ("Unspecified origin not on
 * whitelist.") is auth, exactly as the same words under -32600 always were. Proof of a real revert, as
 * in retry-policy.js (A73c S-12): an ExecutionRevertedError in the chain, hex revert data on some link,
 * or the words "execution reverted".
 * Everything else (timeouts, 429, 5xx, ECONNREFUSED) stays TRANSIENT and keeps today's handling.
 *
 * RUNTIME (createRpcAuthMonitor): every RPC outcome the keeper already observes is reported to ONE
 * per-process monitor, labelled by origin/method ("event-watcher:getLogs", "balance-read", …).
 * [A71 M-1] The streak is kept PER ORIGIN: a success resets only its own origin's streak, so a
 * provider that refuses one method while another works (getBlockNumber ok, getLogs refused) still
 * reaches the threshold; a transient error neither counts nor resets. RPC_AUTH_THRESHOLD consecutive
 * auth errors from one origin ⇒ state `paused: rpc-auth`, ONE high-urgency alert, a reminder at most
 * once per RPC_AUTH_ALERT_COOLDOWN_MS with the suppressed count, and ONE recovery alert once no origin
 * has an open auth streak any more [A71b S-1: every refused origin must answer once — the event
 * watcher reports getBlockNumber, getLogs and its log-processing phase `poll` separately].
 * [A74 S-10] A streak that sees no NEW auth error for RPC_AUTH_STREAK_TTL_MS is aged out (an origin that
 * fails some other way after the key was fixed neither errors "auth" nor succeeds, and would hold the
 * pause for ever), and a count older than that restarts from 1. `muted` (returned by onRpcError) is true ONLY for an auth error
 * while paused — the only case where a caller's own alert (Degraded / "Ops issue: rpc" /
 * consecutive-errors) repeats one the monitor already sent. The state is REPORTED (health, metrics,
 * keeper_runtime_config); it is not a new gate — with the provider refusing, nothing can execute
 * anyway, and the keeper keeps polling so it recovers by itself the moment the key works again.
 *
 * BOOT (createBootAlertGate): chain-verify fails closed as before; executor.js prints
 * `rpc: AUTH REJECTED chain=<id> source=RPC_URL — check provider allowlist/key` and alerts. pm2
 * restarts a failed boot every 5 s up to 50 times, so the boot alert is rate-limited ACROSS processes
 * through a small state file (per chain). If that file cannot be read or written the alert is SENT —
 * failing to rate-limit must never mean failing to alert. [A71 L-3] The file lives in the keeper's
 * OWN state directory (~/.teraswap-keeper, mode 0700), never the shared, world-writable os.tmpdir()
 * where another local user could plant it; a directory others can write is not trusted, and a
 * lastSentAt in the future counts as "never sent" — so no planted or skewed file can mute the alert.
 *
 * Pure apart from the gate's file I/O (injectable; its default directory comes from os.homedir()),
 * no other env reads, no network.
 */

import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { redactUrl } from "./redact.js"

export const RPC_AUTH = "auth"
export const RPC_TRANSIENT = "transient"
/** The `paused` value reported while the provider rejects the keeper's credentials. */
export const PAUSED_RPC_AUTH = "rpc-auth"

/** Consecutive auth errors before the state flips — small: an auth rejection does not heal. */
export const RPC_AUTH_THRESHOLD = 3
/**
 * [A74 S-10] An auth streak with no NEW auth error for this long is aged out. It must outlast the slowest
 * cadence at which an origin that is still refused re-reports (the idle full cycle, 5 min — idle-backoff.js),
 * with margin, so a refused origin is never aged out; and short enough that a streak left open by an origin
 * that failed some OTHER way after the key was fixed cannot hold the pause for long.
 */
export const RPC_AUTH_STREAK_TTL_MS = 900_000
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

// [A73d L-2] Hex revert data (at least a 4-byte selector): the node's `data` on an RpcRequestError, a
// wallet-style nested { data: 0x… }, or ContractFunctionRevertedError.raw. Same test as retry-policy.js
// (which imports this module, so it cannot be shared from there without a cycle).
const isHexRevertData = (d) => typeof d === "string" && /^0x[0-9a-f]{8}/i.test(d)

/** Flatten an error + its .cause chain: statuses, names, text, revert data. Never throws; cycle-safe. */
function walk(err) {
  const statuses = []
  const names = []
  const parts = []
  const seen = new Set()
  let revertData = false
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
    if ([e.data, e.raw, e.data && typeof e.data === "object" ? e.data.data : null].some(isHexRevertData)) revertData = true
    e = e.cause
  }
  return { statuses, names, revertData, text: redactUrl(parts.join(" \n ")).toLowerCase() }
}

/**
 * @param {unknown} err
 * @returns {{ kind: 'auth'|'transient', signal: string|null }} signal = a short, secret-free label
 *   for the alert ("HTTP 403", "not on whitelist", …); null when transient
 */
export function classifyRpcError(err) {
  try {
    const { statuses, names, text, revertData } = walk(err)
    const status = statuses.find((s) => AUTH_STATUS.has(s))
    if (status !== undefined) return { kind: RPC_AUTH, signal: `HTTP ${status}` }
    // [A71 L-2] A real HTTP status that is not 401/403 decides it: transient, body never matched.
    if (statuses.length > 0) return { kind: RPC_TRANSIENT, signal: null }
    // [A73d L-2] viem's GUESS (-32603 ⇒ ContractFunctionRevertedError, no ExecutionRevertedError, no hex
    // revert data) is not a revert: the provider's words below decide. "execution reverted" in the text
    // is still proof on its own.
    const guessedRevert = names.includes("InternalRpcError") && !names.includes("ExecutionRevertedError") && !revertData
    if ((names.includes("ContractFunctionRevertedError") && !guessedRevert) || REVERT_TEXT.test(text)) return { kind: RPC_TRANSIENT, signal: null }
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
 * @returns {{ onRpcError: (origin: string, err: unknown) => Promise<{kind: string, signal: string|null, alerted: boolean, muted: boolean}>,
 *   onRpcSuccess: (origin: string) => Promise<{recovered: boolean}>, state: () => object }}
 *   origin = "<caller>[:<method>]" — one streak per distinct origin.
 *   muted  = auth error AND paused: the caller's legacy alert for it is redundant. Never true otherwise.
 */
export function createRpcAuthMonitor({
  chainId,
  source = "RPC_URL",
  threshold = RPC_AUTH_THRESHOLD,
  cooldownMs = RPC_AUTH_ALERT_COOLDOWN_MS,
  streakTtlMs = RPC_AUTH_STREAK_TTL_MS,
  now = Date.now,
  alert,
  onStateChange = () => {},
  log = () => {},
} = {}) {
  const streaks = new Map() // origin → consecutive auth errors from THAT origin (A71 M-1)
  const streakAt = new Map() // origin → when its LAST auth error arrived (A74 S-10)
  let pausedSince = null
  let lastAlertAt = 0
  let suppressed = 0
  let lastSignal = null
  let lastOrigin = null

  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())
  const maxStreak = () => Math.max(0, ...streaks.values())
  const state = () => ({
    paused: pausedSince == null ? null : PAUSED_RPC_AUTH,
    pausedSince: iso(pausedSince),
    consecutiveAuthErrors: maxStreak(),
    authStreaks: Object.fromEntries(streaks),
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

  // [A74 S-10] Age out every streak whose last auth error is older than the TTL: that origin has not been
  // refused for a whole TTL, which is exactly what a refused origin would have refreshed. Without it an
  // origin that fails some OTHER way after the key was fixed (never an auth error, never a success) holds
  // the pause for ever.
  const pruneStale = (t) => {
    for (const [k, at] of streakAt) {
      if (t - at > streakTtlMs) {
        streaks.delete(k)
        streakAt.delete(k)
      }
    }
  }

  async function onRpcError(origin, err) {
    const { kind, signal } = classifyRpcError(err)
    if (kind !== RPC_AUTH) return { kind, signal, alerted: false, muted: false }
    const t = now()
    pruneStale(t) // a stale count restarts from 1: "consecutive" means within the TTL
    const key = String(origin)
    const consecutive = (streaks.get(key) || 0) + 1
    streaks.set(key, consecutive)
    streakAt.set(key, t)
    lastSignal = signal
    lastOrigin = origin
    // Not paused and this origin is below the threshold: counted only — the caller's own alert stays.
    if (pausedSince == null && consecutive < threshold) return { kind, signal, alerted: false, muted: false }

    const base = { chainId, source, signal, consecutive, threshold, origin }
    if (pausedSince == null) {
      pausedSince = t // set before any await: a concurrent report sees the pause and is rate-limited
      lastAlertAt = t
      suppressed = 0
      log(`rpc: AUTH REJECTED chain=${chainId} source=${source} — check provider allowlist/key`)
      log(`   paused: ${PAUSED_RPC_AUTH} after ${consecutive} consecutive auth errors (last: ${origin}, ${signal})`)
      await safely(() => onStateChange(state()))
      await safely(() => alert({ ...base, phase: "runtime", since: iso(pausedSince), suppressed: 0 }))
      return { kind, signal, alerted: true, muted: true }
    }
    if (t - lastAlertAt >= cooldownMs) {
      const n = suppressed
      lastAlertAt = t
      suppressed = 0
      await safely(() => alert({ ...base, phase: "runtime", since: iso(pausedSince), suppressed: n }))
      return { kind, signal, alerted: true, muted: true }
    }
    suppressed += 1
    return { kind, signal, alerted: false, muted: true }
  }

  async function onRpcSuccess(origin) {
    streaks.delete(String(origin)) // only THIS origin's streak: another origin may still be refused
    streakAt.delete(String(origin))
    pruneStale(now())
    if (pausedSince == null) return { recovered: false }
    // [A71b S-1] Stay paused while ANY origin still has an open auth streak, however short: an origin
    // one or two errors in is still being refused. Clearing on "below the threshold" produced a false
    // recovery alert and a re-pause one error later.
    if (streaks.size > 0) return { recovered: false }
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

/** [A71 L-3] The keeper user's own state directory (created 0700). Resolved per call: HOME may differ. */
export function keeperStateDir() {
  return join(homedir(), ".teraswap-keeper")
}

// [A71b S-2] O_NOFOLLOW makes open() fail (ELOOP) when the LAST path component is a symlink. (Absent on
// Windows, where the flag is simply 0 — the keeper runs on Linux/macOS hosts.)
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const DIRECTORY = constants.O_DIRECTORY ?? 0

const ourUid = () => (typeof process.getuid === "function" ? process.getuid() : null)

/**
 * [A71b S-2] The state directory must be a plain directory, never a symlink: lstat (not stat) looks at
 * the link itself, where stat/chmod would act on whatever it points to — another user's directory
 * forced to 0700, a file written into a place the link's creator chose.
 */
function plainDirStat(d) {
  const st = lstatSync(d)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("state directory is not a plain directory")
  return st
}

/**
 * [A74 S-12] The OPENED state file must be a regular file, ours, with exactly one name: a hard link
 * (nlink > 1) is another name for an inode someone else may control — or one we must not rewrite.
 * `uid` null = the platform has none (not checked). Pure, so it is tested with plain objects.
 * @param {{ isFile(): boolean, uid: number, nlink: number }} st — an fstat of the opened descriptor
 * @param {number|null} uid
 */
export function assertOwnedRegularFile(st, uid) {
  if (!st.isFile()) throw new Error("state file is not a regular file")
  if (uid !== null && st.uid !== uid) throw new Error("state file has the wrong owner (uid)")
  if (st.nlink !== 1) throw new Error("state file has more than one hard link")
}

/**
 * [A74 S-12] The state directory's PARENT (HOME) must not be writable by group or others: whoever can write
 * there can rename or replace `~/.teraswap-keeper` at any moment, and no check on the directory or the file
 * can make that safe. (`stat`, not `lstat`: HOME itself may legitimately be a link to the real directory.)
 */
function assertTrustedParent(d) {
  const p = statSync(dirname(d))
  if (!p.isDirectory() || (p.mode & 0o022) !== 0) throw new Error("untrusted state directory: its parent is writable by others")
}

/**
 * [A74 S-12] Check the directory by path, then pin it by DESCRIPTOR: open it O_DIRECTORY|O_NOFOLLOW, require
 * the same inode as the lstat, ours — and tighten it with fchmod (which acts on the object we hold, never on
 * whatever the path points at by now). Returns the lstat so callers can re-check it after their own open.
 */
function pinStateDir(d, { tighten }) {
  assertTrustedParent(d)
  const before = plainDirStat(d)
  const uid = ourUid()
  const fd = openSync(d, constants.O_RDONLY | NOFOLLOW | DIRECTORY)
  try {
    const st = fstatSync(fd)
    if (!st.isDirectory() || st.dev !== before.dev || st.ino !== before.ino) throw new Error("state directory changed while it was opened")
    if (uid !== null && st.uid !== uid) throw new Error("untrusted state directory")
    if (tighten) fchmodSync(fd, 0o700) // an existing looser directory is tightened (throws if not ours ⇒ not persisted)
    else if ((st.mode & 0o022) !== 0) throw new Error("untrusted state directory")
  } finally {
    closeSync(fd)
  }
  return before
}

/**
 * [A74 S-12] Open the state file and prove, AFTER the open, that what we hold is what we checked: fstat of
 * the descriptor (regular, ours, nlink 1), the path still names that very inode and is not a link, and the
 * directory is still the one we pinned. A swap between the check and the open is a refusal, not a read or
 * write of the new object. Opened WITHOUT O_TRUNC: truncation happens only after these checks.
 */
function openStateFile(f, flags, mode, dirBefore, hooks) {
  const fd = openSync(f, flags | NOFOLLOW, mode)
  try {
    hooks.afterOpen?.() // test seam: a rename-and-replace race, made deterministic
    const st = fstatSync(fd)
    assertOwnedRegularFile(st, ourUid())
    const byPath = lstatSync(f)
    if (byPath.isSymbolicLink() || byPath.dev !== st.dev || byPath.ino !== st.ino) throw new Error("state file changed while it was opened")
    const dirNow = lstatSync(dirname(f))
    if (dirNow.isSymbolicLink() || !dirNow.isDirectory() || dirNow.dev !== dirBefore.dev || dirNow.ino !== dirBefore.ino) {
      throw new Error("state directory changed while the file was opened")
    }
    return fd
  } catch (e) {
    closeSync(fd)
    throw e
  }
}

/**
 * Default gate read: only from a directory this process owns and nobody else can write (under a parent
 * nobody else can write), never via a link, and only from a regular file with one name.
 * @param {string} f
 * @param {{ afterOpen?: () => void }} [hooks] — test seam
 */
export function readOwnedState(f, hooks = {}) {
  const dirBefore = pinStateDir(dirname(f), { tighten: false })
  const fd = openStateFile(f, constants.O_RDONLY, 0, dirBefore, hooks) // a symlinked gate file is refused, not followed
  try {
    return readFileSync(fd, "utf-8")
  } finally {
    closeSync(fd)
  }
}

/**
 * Default gate write: create / tighten the directory to 0700, the file to 0600; refuse any symlink, hard
 * link, non-regular file or swap.
 * @param {string} f
 * @param {string} s
 * @param {{ afterOpen?: () => void }} [hooks] — test seam
 */
export function writeOwnedState(f, s, hooks = {}) {
  const d = dirname(f)
  assertTrustedParent(d) // before mkdir: nothing is created under a parent others can write
  mkdirSync(d, { recursive: true, mode: 0o700 })
  const dirBefore = pinStateDir(d, { tighten: true }) // a link here ⇒ throws before anything is chmodded or written
  const fd = openStateFile(f, constants.O_WRONLY | constants.O_CREAT, 0o600, dirBefore, hooks)
  try {
    ftruncateSync(fd, 0)
    fchmodSync(fd, 0o600) // O_CREAT's mode applies only to a NEW file; an existing 0644 one is tightened here
    writeFileSync(fd, s)
  } finally {
    closeSync(fd)
  }
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
  file = join(keeperStateDir(), `rpc-auth-boot-${chainId}.json`),
  read = readOwnedState,
  write = writeOwnedState,
} = {}) {
  return {
    check() {
      const t = now()
      let prev = null
      try {
        const parsed = JSON.parse(read(file))
        // [A71 L-3] a lastSentAt in the future (planted, or a clock that jumped back) is "never sent":
        // it would otherwise suppress every boot alert until that moment.
        if (parsed && Number.isFinite(parsed.lastSentAt) && parsed.lastSentAt <= t) prev = parsed
      } catch {
        prev = null // missing / unreadable / corrupt / untrusted ⇒ behave as "never sent"
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
