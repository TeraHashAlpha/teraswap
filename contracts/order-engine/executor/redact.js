/**
 * [fix/executor-alert-masking-rpc-auth] The ONE place keeper text is made safe for a log line or a
 * Telegram alert. INC-2026-10-30-001: the Base keeper's balance-read alert interpolated viem's
 * `err.message`, whose `URL:` line carries the provider key in its path (`…/v2/<key>`), and posted
 * the full keyed RPC URL to Telegram.
 *
 * redactUrl(text)  — every URL keeps scheme + host[:port] (the operator still sees WHICH provider)
 *                    and loses userinfo, path, query and fragment: `https://host/REDACTED`.
 * redactError(err) — [fix/keeper-errors-no-signature, A87 S-2] a SHORT text built from the error's fields, never its
 *                    whole `message`: viem's message for a contract call prints the call's `args:` — the order's
 *                    EIP-712 signature — and its request `data:`. See redactError below for what it keeps.
 *
 * What is read first [A74 S-5]: the text is DECODED to a fixpoint (percent, stacked percent, JSON/JS and octal
 * escapes, HTML entities — for `/ : @ ? # \\ %` only), so an encoded delimiter cannot hide a URL; text nested
 * deeper than the decoder goes is replaced by OVER_ENCODED (fail closed).
 *
 * Which URLs, deliberately broad (over-redaction costs a lookup, a leak costs a key rotation):
 *   1. anything with a scheme (http, https, ws, wss, custom; any case) — userinfo included, whatever
 *      characters the password holds [S-7]; an authority that is not a plain host[:port] is dropped
 *      (`[authority-redacted]`) [S-5]; the one exception is `file:///…` (a stack-trace frame, so a redacted
 *      stack keeps its frames);
 *   2. a schemeless `host:port/…` (`127.0.0.1:8545/v2/<key>`, `[::1]:8545/…`) [S-6: after any character];
 *   3. a schemeless dotted host with an alphabetic TLD followed by a path (`provider.example/v2/<key>`), and
 *      a schemeless `user:secret@host/path` loses its userinfo.
 * A bare host (`https://basescan.org`, `api.example.com`) carries no secret and is left alone, so
 * a version string like `viem@2.47.10` is never touched (no alphabetic TLD).
 * `allowHosts` [S-8]: a link to an allow-listed explorer survives ONLY as `/tx|address|block/0x<hex>` on exactly
 * that host (no port, no userinfo); anything else on that host is redacted like any other URL.
 *
 * chain-verify.js keeps its own STRICTER `redactUrls` (whole URL → `<redacted-url>`, plus long hex
 * runs) for its boot refusals; that is a superset of this one and is pinned by its own tests.
 *
 * Every quantifier is bounded or a single pass over a negated class — linear in the input, no
 * nested repetition (a redactor that backtracks inside an alert path is a denial of service); backslash
 * runs are clamped to 8 first [S-9].
 */

// [fix/keeper-errors-no-signature] The keeper's own revert decoders (SwapFailed's inner reason, the executor's market errors).
import { decodeExecutorMarketRevert, decodeSwapFailed, extractRevertData } from "./revert-decode.js"

export const REDACTED = "/REDACTED"

/**
 * Block-explorer hosts whose links the keeper's OWN formatters put in alerts (event-watcher.js
 * EXPLORER_BY_CHAIN — pinned by redact.test.mjs). Only sendTelegramAlert's final pass passes this
 * list; a link to one of these hosts is a public tx link, never a credential. A URL with userinfo
 * is redacted even on an allowed host.
 */
export const ALERT_LINK_HOSTS = Object.freeze(["etherscan.io", "sepolia.etherscan.io", "basescan.org", "arbiscan.io"])

const TAIL = "[^\\s\"'<>(),]*"
// [A71b S-3] No boundary in front of the SCHEME: the leftmost match wins. [A71 L-4] had required "the previous character
// cannot be part of a scheme" (so `rpc_https://` matched, `_` not being one), but a URL glued to 27+
// scheme characters — a 0x address (42 of them) written straight in front of it — then had NO valid
// start at all (the scheme is capped at 31, every later start is preceded by a scheme character) and
// passed untouched. Without the boundary the scheme is simply the last <= 31 scheme characters before
// `://`; whatever precedes them is left as it was, and the URL itself is always redacted. Bounded
// quantifier, one pass: at most 31 characters are tried per start, so the cost stays linear.
// (the scheme pattern is the first alternative of URL_RE, below)
// [A74 S-5] Every URL delimiter — `/ : @ ? #` — and the backslash and percent that spell the others can
// be written in an encoding that hides it from the patterns below: percent (`%2F`, stacked `%252F`),
// JSON / JS escapes (`\u002f`, `\u{2f}`, `\x2f`), octal (`\057`), HTML entities numeric (`&#x2F;`,
// `&#47;`, with or without the closing `;`, behind any number of `&amp;`) and named (`&sol;`). All of
// them are decoded here, to a FIXPOINT (a `&#37;2F` is `%2F` is `/`), before anything looks at the
// text. Over-decoding only ever over-redacts, and only these eight characters are ever produced.
const DELIMS = new Map([
  [0x2f, "/"], [0x3a, ":"], [0x40, "@"], [0x3f, "?"], [0x23, "#"], [0x5c, "\\"], [0x25, "%"],
])
const NAMED = new Map([["sol", "/"], ["colon", ":"], ["commat", "@"], ["quest", "?"], ["num", "#"], ["bsol", "\\"], ["percnt", "%"]])
const fromCode = (n, original) => DELIMS.get(n) ?? original

// `%2F`, `%252F`, `%25252F`…: any number of `25` (an encoded `%`) in front of the byte. A lone `%25`
// is a percent sign, not a delimiter, and is left alone.
const PCT = /%(?:25)*([0-9a-f]{2})/gi
// `\u002f` `\u{2f}` `\x2f` (also double-escaped: one to eight backslashes)
const ESC = /\\{1,8}(?:u0{0,6}([0-9a-f]{2})|u\{0*([0-9a-f]{1,6})\}|x([0-9a-f]{2}))/gi
const OCTAL = /\\{1,8}([0-7]{3})/g
// `&#x2F;` `&#x2F` `&#47;` `&#47` `&sol;`, behind any number of `&amp;` layers. The numeric forms match
// on the code's PREFIX ("&#x2F0xabc" is a slash followed by "0xabc") — an under-decode is a leak.
const ENT = /&(?:amp;)*(?:#x0*(2f|3a|40|3f|23|5c|25);?|#0*(47|58|64|63|35|92|37);?|(sol|colon|commat|quest|num|bsol|percnt);)/gi
// [A71 L-4] JSON-escaped slashes (`https:\/\/host\/v2\/<key>`, also double-escaped)
const ESCAPED_SLASH = /\\{1,8}\//g
// [A74 S-9] `\\+` before a literal is O(N²) on a run of N backslashes that is NOT followed by it (every
// start rescans the run: 80 000 backslashes blocked the loop ~16 s). The decoders above take `\\{1,8}`; a
// longer run is first clamped to 8 in ONE linear pass (a run at its start matches whole), so a long run
// is still decoded — it can never be a hiding place for a delimiter — and never costly.
const LONG_BACKSLASH_RUN = /\\{9,}/g
const EIGHT_BACKSLASHES = "\\".repeat(8)

const MAX_FOLDS = 16
/** Marker returned when the text is nested deeper than the decoder will go: fail closed. */
export const OVER_ENCODED = "[REDACTED: nested encoding]"

function decodeOnce(s) {
  return s
    .replace(LONG_BACKSLASH_RUN, EIGHT_BACKSLASHES)
    .replace(ESCAPED_SLASH, "/")
    .replace(PCT, (m, hex) => (hex === "25" ? m : fromCode(parseInt(hex, 16), m)))
    .replace(ESC, (m, u, ub, x) => fromCode(parseInt(u ?? ub ?? x, 16), m))
    .replace(OCTAL, (m, oct) => fromCode(parseInt(oct, 8), m))
    .replace(ENT, (m, hex, dec, name) =>
      name !== undefined ? NAMED.get(name.toLowerCase()) : fromCode(hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10), m),
    )
}

/** Decode to a fixpoint; null when the text is still changing after MAX_FOLDS (hostile nesting). */
function normalise(text) {
  let s = String(text)
  for (let i = 0; i < MAX_FOLDS; i++) {
    const next = decodeOnce(s)
    if (next === s) return s
    s = next
  }
  return decodeOnce(s) === s ? s : null
}
// [A74 S-6] ONE pass, scheme URL | schemeless path. The schemeless patterns used to start at a "token
// start" (`(?<![\w/:.@-])`), so a keyed URL written after a `/` (what the S-3 `%2F` decode produces), a
// `:`, `@`, `.`, `-`, or glued to a word character (`0x<64 hex>host.example/v2/KEY`) was never seen.
// They no longer find a host at all: they find the PATH DELIMITER and look BEHIND it for a host
// (`dotted.host` with an alphabetic TLD, or `host:port`), then redact from the delimiter on — the host
// text in front of it is left exactly as it was, whatever precedes it. Being alternatives of the same
// regex as the scheme URL, text a scheme URL already consumed (an allowed explorer link, an
// already-redacted `https://host/REDACTED`) is never scanned again. Cost: the lookahead rejects every
// position that is not `/ ? #` in O(1); the lookbehind then reads at most a few hundred characters.
const HOST_BEHIND = "(?:(?:[a-z0-9_-]{1,63}\\.){1,8}[a-z]{2,24}|(?:\\[[0-9a-f:.]{2,45}\\]|[a-z0-9_.-]{1,255}):\\d{1,5})"
// [A74 S-7] The userinfo is matched ON ITS OWN, in front of TAIL: everything up to the last `@` before the
// first `/ ? #` or whitespace. TAIL stops at `( ) , ' " < >`, so a password containing one of them used to
// end the match inside the userinfo and leave the rest of it (and the real host and path) in the text.
// One scan of a negated class to the end of the segment (`/` cannot be in it), so it stays linear.
const URL_RE = new RegExp(
  `([a-z][a-z0-9+.-]{0,30})://((?:[^\\s/?#]*@)?)(${TAIL})|((?=[/?#])(?<=${HOST_BEHIND})[/?#]${TAIL})`,
  "gi",
)

// [A74 S-6] `user:secret@host.example/path` with no scheme: the `@` followed by a host and a path
// delimiter. The userinfo is the run of non-delimiter characters in front of the `@` (at most 255). It runs
// AFTER URL_RE, which has already removed every scheme URL's own userinfo.
const AT_HOST = new RegExp(
  `@(?=(?:(?:[a-z0-9_-]{1,63}\\.){1,8}[a-z]{2,24}|(?:\\[[0-9a-f:.]{2,45}\\]|[a-z0-9_.-]{1,255}):\\d{1,5})[/?#])`,
  "gi",
)
const USERINFO_STOP = /[\s/?#@"'<>]/
function stripBareUserinfo(s) {
  if (!s.includes("@")) return s
  let out = ""
  let last = 0
  for (const m of s.matchAll(AT_HOST)) {
    let start = m.index
    while (start > last && m.index - start < 255 && !USERINFO_STOP.test(s[start - 1])) start--
    if (start === m.index) continue // nothing in front of the "@": not a userinfo
    out += s.slice(last, start)
    last = m.index + 1
  }
  return last === 0 ? s : out + s.slice(last)
}

// [A74 S-8] The only path an allow-listed explorer host may keep: exactly the links event-watcher.js
// builds (`/tx/0x<hash>`; `/address` and `/block` for the same family) — no query, fragment, extra
// segment or non-hex tail. The host test alone let `https://basescan.org/api?apikey=KEY` through.
const EXPLORER_TAIL = /^\/(?:tx|address|block)\/0x[0-9a-f]+$/i

/** What stands in for an authority that is not a plain host[:port]. */
export const AUTHORITY_DROPPED = "[authority-redacted]"
const PLAIN_HOSTPORT = /^(?:[a-z0-9_.-]{1,255}|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/i

/**
 * @param {unknown} text
 * @param {{ allowHosts?: readonly string[] }} [opts] — hosts whose path-bearing links survive
 *   (sendTelegramAlert passes ALERT_LINK_HOSTS; nothing else should)
 * @returns {string}
 */
export function redactUrl(text, { allowHosts = [] } = {}) {
  const allow = new Set(allowHosts.map((h) => h.toLowerCase()))
  const decoded = normalise(text)
  if (decoded === null) return OVER_ENCODED // nested deeper than any real error: say nothing rather than half
  const redacted = decoded.replace(URL_RE, (match, scheme, userinfo, rest, bare) => {
    if (bare !== undefined) return REDACTED
    // A `file:///…` frame in a stack trace is a local path, not an endpoint — keep the frames.
    if (scheme.toLowerCase() === "file" && userinfo === "") return match
    const end = rest.search(/[/?#]/)
    const authority = end === -1 ? rest : rest.slice(0, end)
    const tail = end === -1 ? "" : rest.slice(end)
    // [A74 S-5] The authority must be a plain host[:port]; anything else (`host:KEY`, `host;KEY`, an
    // escape that did not decode) is dropped, never echoed back.
    if (!PLAIN_HOSTPORT.test(authority)) return `${scheme}://${AUTHORITY_DROPPED}${REDACTED}`
    if (userinfo === "" && (tail === "" || tail === "/")) return match
    if (userinfo === "" && allow.has(authority.toLowerCase()) && EXPLORER_TAIL.test(tail)) return match
    return `${scheme}://${authority}${REDACTED}`
  })
  // After the URL pass, so a scheme URL's own userinfo (already gone) is never this one's business.
  return stripBareUserinfo(redacted)
}

// ── [fix/keeper-errors-no-signature] A87 S-2: what an error may say in a log line or an alert ──────────────────────
// viem's message for a contract call is the whole call: the Contract Call block prints `args:` (the order struct and
// its EIP-712 signature), Raw Call / Request Arguments print `data:` (the calldata, which embeds the same signature),
// Request body prints the JSON-RPC request. Measured on origin/main for canExecute and executeOrder under revert, RPC
// error and timeout: 9 of 9 put the signature in the log line and the Telegram text, which ran to 14,907 characters
// (Telegram refuses more than 4,096; the alert was lost). viem's shortMessage never carries the arguments.

/** The longest text redactError returns. */
export const ERROR_TEXT_MAX = 600
/** The start of the visible marker a cut text ends with: `…[truncated N chars]`. */
export const TRUNCATED = "…[truncated"
/** @param {number} n */
export const truncatedMarker = (n) => `${TRUNCATED} ${n} chars]`

const UNPRINTABLE = "[unprintable error]"
// viem's own diagnostic lines, kept from a multi-line message (owner answer 1, 2026-11-18): where the call went,
// what the transport answered, what the node said (`Details: … not on whitelist` is the INC-2026-10-30-001 auth
// signal). Every other line of the message is dropped.
const KEPT_LINE = /[ \t]{0,8}(?:URL|Status|Details):/y
const MAX_KEPT_LINES = 8
// The blocks the scrub removes from whatever text remains (a string handed in, a first line, a kept line): an
// `args:` or `data:` line, and a `Request Arguments:` / `Raw Call Arguments:` header with its indented lines.
const DROPPED_LINE = /^[ \t]{0,64}(?:args|data)[ \t]{0,8}:/i
const BLOCK_HEAD = /^[ \t]{0,64}(?:Request|Raw Call) Arguments[ \t]{0,8}:/i
const BLOCK_HINT = /(?:^|\n)[ \t]{0,64}(?:args|data|Request Arguments|Raw Call Arguments)[ \t]{0,8}:/i
// Any run of 130+ hex digits (a 65-byte signature is 130; calldata, raw transactions, revert blobs are longer).
const HEX_RUN = /[0-9a-f]{130,}/gi
// What reaches the URL redactor is bounded first (a multi-megabyte message costs one linear scan, no more). The
// cut lands on whitespace: a URL, a userinfo and a hex run are each one whitespace-free token, so none is split
// into a shape the patterns no longer see; a token with no whitespace before the bound is dropped whole.
const PRE_MAX = 16_384
const LINE_MAX = 4_096
const REASON_MAX = 512
const ERROR_NAME = /^[A-Za-z_$][\w$]{0,79}$/

/** A string property, or undefined; a getter that throws reads as absent. */
function readString(obj, key) {
  try {
    const v = obj[key]
    return typeof v === "string" ? v : undefined
  } catch {
    return undefined
  }
}

function safeString(v) {
  try {
    return String(v)
  } catch {
    return UNPRINTABLE
  }
}

/** At most `max` characters, cut where whitespace begins (see PRE_MAX). @returns {{ text: string, cut: number }} */
function preSlice(s, max) {
  if (s.length <= max) return { text: s, cut: 0 }
  let end = max
  while (end > 0 && !/\s/.test(s[end])) end--
  return { text: s.slice(0, end), cut: s.length - end }
}

const oneLine = (s, max) => preSlice(s, max).text.replace(/[ \t]*[\r\n][\r\n \t]*/g, " ").trim()

/** viem's / the executor's decoded revert reason anywhere in the cause chain, or null. Never throws. */
function revertReason(err) {
  let data = null
  try {
    data = extractRevertData(err)
  } catch {
    /* a hostile getter on the chain: no data */
  }
  try {
    const sf = decodeSwapFailed(data)
    if (sf) return `SwapFailed: ${sf.reason}`
  } catch {
    /* not decodable */
  }
  try {
    const seen = new Set()
    let e = err
    for (let depth = 0; e !== null && typeof e === "object" && depth < 16 && !seen.has(e); depth++) {
      seen.add(e)
      if (readString(e, "name") === "ContractFunctionRevertedError") {
        const reason = readString(e, "reason")
        if (reason) return reason
        const decoded = e.data
        const errorName = decoded !== null && typeof decoded === "object" ? readString(decoded, "errorName") : undefined
        if (errorName) return errorName
      }
      e = e.cause
    }
  } catch {
    /* a hostile getter: what was read so far */
  }
  try {
    const market = decodeExecutorMarketRevert(data)
    if (market) return market.name
  } catch {
    /* not decodable */
  }
  return null
}

/** The text redactError starts from: name, short message, revert reason, viem's URL/Status/Details lines. */
function composeErrorText(err) {
  if (err === null || err === undefined) return String(err)
  if (typeof err !== "object") return typeof err === "string" ? err : safeString(err)
  const name = readString(err, "name")
  const short = readString(err, "shortMessage")
  const message = readString(err, "message")
  const nl = message ? message.indexOf("\n") : -1
  const head = short || (message ? (nl === -1 ? message : message.slice(0, nl)) : "")
  if (!head) return safeString(err)
  let first = oneLine(head, LINE_MAX)
  // The class says what failed (ContractFunctionExecutionError, HttpRequestError, TypeError); a plain `Error` says
  // nothing, and its existing log lines carry no prefix (chainlink-debug-read.test.mjs pins one).
  if (name && name !== "Error" && ERROR_NAME.test(name)) first = `${name}: ${first}`
  const reason = revertReason(err)
  if (reason) {
    const r = oneLine(reason, REASON_MAX)
    if (r && !first.includes(r)) first = `${first} — reason: ${r}`
  }
  const lines = [first]
  // viem's diagnostic lines, in the message's order; a sticky test at each line start (no copy of other lines).
  for (let i = nl; i !== -1 && lines.length <= MAX_KEPT_LINES; i = message.indexOf("\n", i + 1)) {
    KEPT_LINE.lastIndex = i + 1
    if (!KEPT_LINE.test(message)) continue
    const end = message.indexOf("\n", i + 1)
    lines.push(oneLine(message.slice(i + 1, end === -1 ? message.length : end), LINE_MAX))
  }
  return lines.join("\n")
}

/** Drop the `args:` / `data:` lines and the Request / Raw Call Arguments blocks. */
function dropBlocks(s) {
  if (!BLOCK_HINT.test(s)) return s
  const kept = []
  let inBlock = false
  for (const line of s.split("\n")) {
    if (inBlock && /^[ \t]/.test(line) && line.trim() !== "") continue
    inBlock = false
    if (BLOCK_HEAD.test(line)) {
      inBlock = true
      continue
    }
    if (!DROPPED_LINE.test(line)) kept.push(line)
  }
  return kept.join("\n")
}

/**
 * `s` cut to at most `max` characters ending with the marker, or `s` itself when it fits and nothing was cut before.
 * @param {string} s @param {number} max @param {number} [alreadyCut] — characters an earlier bound removed
 */
function capText(s, max, alreadyCut = 0) {
  if (alreadyCut === 0 && s.length <= max) return s
  const room = max - truncatedMarker(s.length + alreadyCut).length - 1
  let keep = Math.max(0, Math.min(s.length, room))
  if (keep > 0 && keep < s.length && /[\uD800-\uDBFF]/.test(s[keep - 1])) keep-- // never half a surrogate pair
  const out = `${s.slice(0, keep)}${keep > 0 ? " " : ""}${truncatedMarker(s.length - keep + alreadyCut)}`
  return out.length <= max ? out : out.slice(0, max)
}

/**
 * The printable text of an error for a log line or an alert, redacted and short. Never throws (non-errors, circular
 * cause chains, getters that throw). In order:
 *   1. `Name: shortMessage` (else the first line of `message`; a string is taken as it is; no prefix for a plain
 *      `Error`), then ` — reason: …` with
 *      the decoded revert reason when the error carries one (viem's Error(string)/Panic text or custom error name,
 *      or the executor's SwapFailed inner reason), then viem's `URL:`, `Status:` and `Details:` lines;
 *   2. every URL redaction (redactUrl);
 *   3. the scrub: `args:` / `data:` lines and Request / Raw Call Arguments blocks removed, any run of 130+ hex
 *      digits replaced by `<hex N>`;
 *   4. the cap: ERROR_TEXT_MAX (600) characters, or `max` when smaller, ending with `…[truncated N chars]`.
 * @param {unknown} err — an Error (viem or not), a string, or anything else
 * @param {{ max?: number }} [opts] — a lower cap for one call site
 * @returns {string}
 */
export function redactError(err, { max } = {}) {
  const cap = Number.isInteger(max) && max > 0 ? Math.min(max, ERROR_TEXT_MAX) : ERROR_TEXT_MAX
  let text = UNPRINTABLE
  let cut = 0
  try {
    ;({ text, cut } = preSlice(composeErrorText(err), PRE_MAX))
  } catch {
    /* unprintable */
  }
  let out = UNPRINTABLE
  try {
    out = dropBlocks(redactUrl(text)).replace(HEX_RUN, (m) => `<hex ${m.length}>`)
  } catch {
    /* unprintable */
  }
  return capText(out, cap, cut)
}
