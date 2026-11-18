/**
 * [fix/executor-alert-masking-rpc-auth] The ONE place keeper text is made safe for a log line or a
 * Telegram alert. INC-2026-10-30-001: the Base keeper's balance-read alert interpolated viem's
 * `err.message`, whose `URL:` line carries the provider key in its path (`…/v2/<key>`), and posted
 * the full keyed RPC URL to Telegram.
 *
 * redactUrl(text)  — every URL keeps scheme + host[:port] (the operator still sees WHICH provider)
 *                    and loses userinfo, path, query and fragment: `https://host/REDACTED`; a `0x` hex run of
 *                    130+ digits (a signature, calldata, a raw transaction) becomes `0x<hex N>`.
 * redactUrlOnly(t) — [A92 S-5] the same URL redaction WITHOUT the hex scrub, for text that is classified and never
 *                    printed (rpc-auth.js): it reads exactly the text it read on origin/main.
 * redactError(err) — [fix/keeper-errors-no-signature, A87 S-2] a SHORT text built from the error's fields, never its
 *                    whole `message`: viem's message for a contract call prints the call's `args:` — the order's
 *                    EIP-712 signature — and its request `data:`. See redactError below for what it keeps.
 * capAlertText(t)  — a Telegram HTML text cut below Telegram's 4,096 limit with a visible marker, never inside a tag
 *                    or an entity, open tags closed (Telegram refuses a longer or unbalanced text: the alert is lost).
 * redactSecretLiterals(t) — [A93 R2-1] every CONFIGURED secret (SECRET_ENV_NAMES, read from the environment by name)
 *                    replaced by `<redacted>` wherever it stands, in any case, percent-encoded or not: the first and the
 *                    last step of redactUrl (so of sendTelegramAlert's final pass), the last of redactError (whose
 *                    fields are scrubbed as read, too), and of every line the operator CLIs print. A provider that
 *                    echoes only the request target (`Cannot POST /v2/<key>`) gives the URL patterns no host to anchor on.
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
 * [A92 S-5] The URL redaction alone, with no hex scrub: exactly what redactUrl returned on origin/main 7bd3ec12.
 * Only for text that is classified and never printed (rpc-auth.js reads the provider's words in it); a printed text
 * goes through redactUrl.
 * @param {unknown} text
 * @param {{ allowHosts?: readonly string[] }} [opts]
 * @returns {string}
 */
export function redactUrlOnly(text, { allowHosts = [] } = {}) {
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

/**
 * @param {unknown} text
 * @param {{ allowHosts?: readonly string[], html?: boolean }} [opts] — allowHosts: hosts whose path-bearing links
 *   survive (sendTelegramAlert passes ALERT_LINK_HOSTS; nothing else should); html: the text is Telegram HTML, so a
 *   configured secret becomes `&lt;redacted&gt;` (a raw `<redacted>` is a tag Telegram refuses: the alert is lost)
 * @returns {string}
 */
export function redactUrl(text, opts) {
  // [A93 R2-1] The configured secrets by value, FIRST (as the text came: the decoder below folds escapes, and a secret
  // that holds one would no longer read as itself) and LAST (what the decoder revealed, `%252F` -> `/`): a path echoed
  // with no host in front of it survives the URL pass.
  const html = opts?.html === true
  return redactSecretLiterals(redactUrlAndHex(redactSecretLiterals(text, { html }), opts), { html })
}

// [A93 R2-1] A secret already masked inside a URL path stops the URL pattern's tail at `<` (`https://host/v2/<redacted>`
// would read `https://host/REDACTED<redacted>`): the mask and the rest of that tail are part of the redacted path.
const MASK_IN_PATH = /\/REDACTED(?:<redacted>[^\s"'<>(),]*)+/g

/** redactUrl without the secret scrub: for redactError, which scrubs its own fields first and its text last. */
function redactUrlAndHex(text, opts) {
  // [fix/keeper-errors-no-signature] The URL redaction, then a `0x` hex run of 130+ digits: executor.js logs a fatal
  // error as redactUrl(err.stack), and a viem stack repeats the whole message (the order signature in `args:`); every
  // Telegram alert passes here last (sendTelegramAlert). Only the `0x` form: a bare run of the letters a-f is
  // ordinary text to this function (redact-s6-schemeless.test.mjs and redact-shapes.test.mjs pin such runs).
  return redactUrlOnly(text, opts)
    .replace(MASK_IN_PATH, REDACTED)
    .replace(HEX_RUN_0X, (m) => `0x<hex ${m.length - 2}>`)
}

// ── [A93 R2-1] Configured secrets, removed by their literal value ─────────────────────────────────────────────────────
// A provider error that echoes only the request TARGET (`no route for /v2/<key>?apikey=<key>`, an Express-style
// `Cannot POST /v2/<key>` page) has no host in front of the path, so no URL pattern above sees it; it reached the keeper
// log, the Telegram alerts and the CLIs' output. The keeper knows its secrets — they are in its environment — so they
// are removed by value, the way the app removes its bot token (src/lib/alert-channels/utils.ts scrubAlertText).

/**
 * Every environment variable whose value is, or carries, a secret: read by the keeper (executor.js and its modules), by
 * the operator CLIs, or by the SDK the keeper signs with. A value that is an http(s)/ws(s) URL gives its userinfo, each
 * path segment and each query value (never the host: the operator must still see WHICH provider failed); any other
 * value is a secret whole, and also without its `0x` prefix (a private key is printed either way).
 */
export const SECRET_ENV_NAMES = Object.freeze([
  "RPC_URL", // executor.js, list-missing-fills.mjs
  "BACKFILL_RPC_URL", // backfill-execution.mjs
  "FLASHBOTS_RPC_URL", // executor.js
  "TERASWAP_API_URL", // executor.js (the swap route API)
  "VAULT_ADDR", // executor.js (a Vault signer address; not wired yet)
  "SUPABASE_URL", // executor.js, both CLIs
  "SUPABASE_SERVICE_ROLE_KEY", // executor.js, both CLIs
  "TELEGRAM_BOT_TOKEN", // alert.js
  "EXECUTOR_PRIVATE_KEY", // executor.js (the plaintext signer)
  "HEALTH_TOKEN", // executor.js (the /health bearer token)
  "COINGECKO_API_KEY", // price-sources.js
  "AWS_ACCESS_KEY_ID", // kms-signer.js: @aws-sdk/client-kms reads the AWS credentials from the environment
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
])
/** A configured value or URL part shorter than this is never treated as a secret (`v2`, `base`, `rpc`, `api`). */
export const SECRET_MIN_LENGTH = 12
/** What stands in for a configured secret. */
export const SECRET_MASK = "<redacted>"
const SECRET_MASK_HTML = "&lt;redacted&gt;"
/** What a text becomes when the scrub itself cannot run (a text too long to hold twice in memory): fail closed. */
export const SECRET_SCRUB_FAILED = "[REDACTED: text too long to scrub]"

const URL_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"])
const decodeLoose = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The configured secret literals in `env`, read by NAME (SECRET_ENV_NAMES). Never logged, never returned to a caller. */
function secretLiterals(env) {
  const out = new Set()
  const keep = (s) => {
    if (s.length >= SECRET_MIN_LENGTH) out.add(s)
  }
  for (const name of SECRET_ENV_NAMES) {
    const raw = env[name]
    if (typeof raw !== "string") continue // unset
    const value = raw.trim()
    let url = null
    try {
      url = new URL(value)
    } catch {
      /* not a URL: the whole value is the secret */
    }
    if (url !== null && URL_PROTOCOLS.has(url.protocol)) {
      keep(decodeLoose(url.username))
      keep(decodeLoose(url.password))
      for (const segment of url.pathname.split("/")) keep(decodeLoose(segment))
      // `?<key>` with no `=` is a value too (the whole pair)
      for (const pair of url.search.slice(1).split("&")) keep(decodeLoose(pair.slice(pair.indexOf("=") + 1)))
    } else {
      keep(value)
      if (/^0x/i.test(value)) keep(value.slice(2))
    }
  }
  return [...out]
}

// The scrub compares CANONICAL bytes, so one search finds every way a secret is written: each `%XX` is the byte it
// encodes (any mix of encoded and plain characters, either hex case), each HTML entity (`&amp;` `&lt;` `&#47;` `&#x2F;`,
// what Telegram's HTML text carries) and each JSON / JS string escape (`\"` `\'` `\\` `\/` `/`, an error body
// quoted as JSON) is its character, ASCII letters are lower case (an upper-cased or lower-cased echo), and a line break
// with the spaces and tabs around it is nothing at all (a key split over two lines is still the key). Other characters
// are their UTF-8 bytes. A plain space that touches no line break is an ordinary character.
// One pass over the text, a map back to its positions, an indexOf per form: linear, no regex (a pattern per secret
// character overflows V8's regex compiler at about 1,200 characters, and an AWS session token is longer).
const ENTITY_AT = /&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/y
const NAMED_ENTITY = { amp: 38, lt: 60, gt: 62, quot: 34, apos: 39 }
const isHexCode = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
const hexValue = (c) => (c <= 57 ? c - 48 : (c | 32) - 87)
const lowerByte = (b) => (b >= 65 && b <= 90 ? b + 32 : b)
const isBlank = (c) => c === 32 || c === 9
const isBreak = (c) => c === 10 || c === 13

/** Emit the UTF-8 bytes of `cp`, ASCII lower-cased, each with the source span [start, end). Stops when emit says so. */
function emitCodePoint(cp, start, end, emit) {
  if (cp < 0x80) return emit(lowerByte(cp), start, end)
  if (cp < 0x800) return emit(0xc0 | (cp >> 6), start, end) || emit(0x80 | (cp & 63), start, end)
  if (cp < 0x10000) {
    return emit(0xe0 | (cp >> 12), start, end) || emit(0x80 | ((cp >> 6) & 63), start, end) || emit(0x80 | (cp & 63), start, end)
  }
  return (
    emit(0xf0 | (cp >> 18), start, end) ||
    emit(0x80 | ((cp >> 12) & 63), start, end) ||
    emit(0x80 | ((cp >> 6) & 63), start, end) ||
    emit(0x80 | (cp & 63), start, end)
  )
}

/** The escape that starts at `i` (`%XX`; `\"` `\'` `\\` `\/` `\uXXXX`; an HTML entity): `{ byte | cp, len }`, or null. */
function readEscape(text, i, n) {
  const c = text.charCodeAt(i)
  if (c === 37 && i + 2 < n && isHexCode(text.charCodeAt(i + 1)) && isHexCode(text.charCodeAt(i + 2))) {
    return { byte: lowerByte(hexValue(text.charCodeAt(i + 1)) * 16 + hexValue(text.charCodeAt(i + 2))), len: 3 }
  }
  if (c === 92 && i + 1 < n) {
    const d = text.charCodeAt(i + 1)
    if (d === 34 || d === 39 || d === 92 || d === 47) return { byte: d, len: 2 }
    if (d === 117 && i + 5 < n && [2, 3, 4, 5].every((k) => isHexCode(text.charCodeAt(i + k)))) {
      return { cp: parseInt(text.slice(i + 2, i + 6), 16), len: 6 }
    }
  }
  if (c === 38) {
    ENTITY_AT.lastIndex = i
    const m = ENTITY_AT.exec(text)
    const cp = m === null ? -1 : m[1] ? NAMED_ENTITY[m[1]] : m[2] ? Number(m[2]) : parseInt(m[3], 16)
    if (cp >= 0 && cp <= 0x10ffff) return { cp, len: m[0].length }
  }
  return null
}

/**
 * Walk `text` as canonical bytes (see above); `emit(byte, start, end)` returning true stops the walk. With `decode`
 * false, no escape is read (only the case and the line breaks): the PLAIN walk, for a secret that holds `%`, `\` or
 * `&` itself — written as it is, such a secret can merge with the text around it into an escape (`<key>\` before
 * `/rest` reads `\/`) that the decoding walk would fold.
 */
function eachCanonicalByte(text, emit, decode = true) {
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (isBlank(c) || isBreak(c)) {
      let j = i
      while (j < n && isBlank(text.charCodeAt(j))) j++
      if (j < n && isBreak(text.charCodeAt(j))) {
        while (j < n && (isBlank(text.charCodeAt(j)) || isBreak(text.charCodeAt(j)))) j++
        i = j
        continue
      }
      for (; i < j; i++) if (emit(text.charCodeAt(i), i, i + 1)) return
      continue
    }
    if (decode) {
      const e = readEscape(text, i, n)
      if (e !== null) {
        if (e.byte !== undefined ? emit(e.byte, i, i + e.len) : emitCodePoint(e.cp, i, i + e.len, emit)) return
        i += e.len
        continue
      }
    }
    const cp = text.codePointAt(i)
    const len = cp > 0xffff ? 2 : 1
    if (emitCodePoint(cp, i, i + len, emit)) return
    i += len
  }
}

/** The canonical byte string of `text`, one char per byte (`decode`: see eachCanonicalByte). */
function canonical(text, decode = true) {
  const parts = []
  let chunk = []
  eachCanonicalByte(text, (b) => {
    chunk.push(b)
    if (chunk.length === 8192) {
      parts.push(String.fromCharCode.apply(null, chunk))
      chunk = []
    }
    return false
  }, decode)
  parts.push(String.fromCharCode.apply(null, chunk))
  return parts.join("")
}

/** A text's UTF-8 bytes, ASCII lower-cased, nothing decoded: how it reads when every character is percent-encoded. */
function rawBytes(text) {
  const parts = []
  for (const ch of text) emitCodePoint(ch.codePointAt(0), 0, 0, (b) => (parts.push(String.fromCharCode(b)), false))
  return parts.join("")
}

/** Escape-like tokens of one literal read both ways in every combination up to this many; beyond, all or none. */
const MAX_ESCAPE_TOKENS = 6
/** The end of a value that could be the start of an escape (at most 9 characters: `&#x10ffff`). */
const ESCAPE_START_TAIL = /(?:%[0-9a-f]?|\\(?:u[0-9a-f]{0,3})?|&[#a-z0-9]{0,8})$/i

/**
 * The canonical forms of a literal. A real key holds no escape-like token and has one form. A literal that does (a
 * `%XX`, an entity, a `\` escape or a line break in the configured value itself) reads differently depending on how
 * each of its characters was written: a token written plainly is decoded by the walk, a token with any character
 * encoded is not. Every combination is a form (64 at most).
 */
function literalForms(literal) {
  const tokens = [] // { decoded, raw }, in order; a skipped line break is { decoded: "" }
  let pos = 0
  let current = null
  eachCanonicalByte(literal, (b, start, end) => {
    if (current !== null && start === current.start) {
      current.decoded += String.fromCharCode(b)
      return false
    }
    if (start > pos) tokens.push({ decoded: "", raw: rawBytes(literal.slice(pos, start)) })
    current = { start, decoded: String.fromCharCode(b), raw: rawBytes(literal.slice(start, end)) }
    tokens.push(current)
    pos = end
    return false
  })
  if (pos < literal.length) tokens.push({ decoded: "", raw: rawBytes(literal.slice(pos)) })
  const escapes = tokens.filter((t) => t.decoded !== t.raw).length
  const forms = new Set()
  const build = (pickRaw) => {
    let e = 0
    return tokens.map((t) => (t.decoded === t.raw ? t.decoded : pickRaw(e++) ? t.raw : t.decoded)).join("")
  }
  if (escapes > MAX_ESCAPE_TOKENS) {
    forms.add(build(() => false))
    forms.add(build(() => true))
  } else {
    for (let mask = 0; mask < 2 ** escapes; mask++) forms.add(build((i) => (mask >> i) & 1))
  }
  forms.delete("")
  return [...forms]
}

/** Every configured secret's canonical forms (`decoded`), and the raw bytes of each one that holds `%`, `\` or `&`
 *  (`plain`, matched by the plain walk). */
function secretForms(env) {
  const decoded = new Set()
  const plain = new Set()
  for (const literal of secretLiterals(env)) {
    for (const form of literalForms(literal)) decoded.add(form)
    if (/[%\\&]/.test(literal)) plain.add(rawBytes(literal))
    // A value that ends where an escape could begin (`%`, `%4`, `\`, `\u12`, `&`, `&#x2`) merges with the text after it
    // (`<key>\` + `"` reads `"`, `<key>%` + `de` reads one byte): also search for it without that tail.
    const tail = ESCAPE_START_TAIL.exec(literal)
    if (tail !== null && tail.index >= SECRET_MIN_LENGTH) for (const form of literalForms(literal.slice(0, tail.index))) decoded.add(form)
  }
  return { decoded: [...decoded], plain: [...plain], none: decoded.size === 0 }
}

// [A93 R2-1] Built lazily, ONCE, at the first scrub: every entrypoint imports ./env.js first, so .env.executor is in
// process.env before anything is redacted (env.js's own "could not load" warning runs only when no file was loaded).
let configuredForms = null
function configuredSecretForms() {
  if (configuredForms === null) configuredForms = secretForms(process.env)
  return configuredForms
}

/** The source spans of `text` that read as one of `forms` under the walk `decode` selects; sorted, disjoint. */
function spansOf(text, forms, decode) {
  if (forms.length === 0) return []
  const canon = canonical(text, decode)
  const found = []
  for (const form of forms) {
    for (let k = canon.indexOf(form); k !== -1; k = canon.indexOf(form, k + 1)) found.push([k, k + form.length])
  }
  if (found.length === 0) return []
  found.sort((x, y) => x[0] - y[0])
  const merged = []
  for (const [lo, hi] of found) {
    const last = merged[merged.length - 1]
    if (last && lo < last[1]) last[1] = Math.max(last[1], hi)
    else merged.push([lo, hi])
  }
  // Second walk: canonical byte index -> source span. The ranges are sorted and disjoint, so at most one starts and at
  // most one ends at any byte.
  const spans = merged.map(() => [0, 0])
  let k = 0
  let r = 0
  eachCanonicalByte(
    text,
    (_b, start, end) => {
      if (k === merged[r][0]) spans[r][0] = start
      if (k === merged[r][1] - 1) {
        spans[r][1] = end
        r++
      }
      k++
      return r === merged.length
    },
    decode,
  )
  return spans
}

/** `text` with every span that reads as one of the configured forms replaced by `mask`. */
function scrubForms(text, forms, mask) {
  const spans = [...spansOf(text, forms.decoded, true), ...spansOf(text, forms.plain, false)].sort((x, y) => x[0] - y[0])
  if (spans.length === 0) return text
  let out = ""
  let last = 0
  for (const [start, end] of spans) {
    if (start < last) {
      last = Math.max(last, end) // overlapping spans (two walks, or one multi-byte character): one mask
      continue
    }
    out += text.slice(last, start) + mask
    last = end
  }
  return out + text.slice(last)
}

/**
 * [A93 R2-1] `text` with every configured secret (SECRET_ENV_NAMES, by value, at least SECRET_MIN_LENGTH characters)
 * replaced by `<redacted>`: plain, percent-encoded (any mix), any case, HTML- or JSON-escaped, or split by a line break. Never
 * throws; never says which secret or which variable matched. Not for text that is classified (rpc-auth.js,
 * retry-policy.js read the raw error): a decision must not depend on what is configured.
 * @param {unknown} text
 * @param {{ html?: boolean }} [opts] — html: the mask is `&lt;redacted&gt;` (Telegram HTML)
 * @returns {string}
 */
export function redactSecretLiterals(text, { html = false } = {}) {
  const s = typeof text === "string" ? text : safeString(text)
  try {
    const forms = configuredSecretForms()
    return forms.none ? s : scrubForms(s, forms, html ? SECRET_MASK_HTML : SECRET_MASK)
  } catch {
    return SECRET_SCRUB_FAILED // a text too long to hold twice: say nothing rather than everything
  }
}

// ── [fix/keeper-errors-no-signature] A87 S-2: what an error may say in a log line or an alert ──────────────────────
// viem's message for a contract call is the whole call: the Contract Call block prints `args:` (the order struct and
// its EIP-712 signature), Raw Call / Request Arguments print `data:` (the calldata, which embeds the same signature),
// Request body prints the JSON-RPC request. Measured on origin/main for canExecute and executeOrder under revert, RPC
// error and timeout: 9 of 9 put the signature in the log line and the Telegram text, which ran to 14,907 characters
// (Telegram refuses more than 4,096; the alert was lost). viem's shortMessage never carries the arguments.

/** The longest text redactError returns. */
export const ERROR_TEXT_MAX = 600
/** Every keeper Telegram text is cut to this (Telegram's limit is 4,096 characters after entity parsing). */
export const ALERT_TEXT_MAX = 4_000
/** The start of the visible marker a cut text ends with: `…[truncated N chars]`. */
export const TRUNCATED = "…[truncated"
/** @param {number} n */
export const truncatedMarker = (n) => `${TRUNCATED} ${n} chars]`

const UNPRINTABLE = "[unprintable error]"
// viem's own diagnostic lines, kept from a multi-line message (owner answer 1, 2026-11-18): where the call went,
// what the transport answered, what the node said (`Details: … not on whitelist` is the INC-2026-10-30-001 auth
// signal). [A92 S-3] And from viem's Contract Call block, which contract and which function: the `address:` line,
// and the `function:` line cut at its parenthesis (the name, never the parameter list). The block's `args:` line (the
// order and its signature) and `sender:` line are not kept. Every other line of the message is dropped.
const KEPT_LINE = /[ \t]{0,8}(URL|Status|Details|address|function):/y
const MAX_KEPT_LINES = 8
// The blocks the scrub removes from whatever text remains (a string handed in, a first line, a kept line): an
// `args:` or `data:` line, and a `Request Arguments:` / `Raw Call Arguments:` header with its indented lines.
const DROPPED_LINE = /^[ \t]{0,64}(?:args|data)[ \t]{0,8}:/i
const BLOCK_HEAD = /^[ \t]{0,64}(?:Request|Raw Call) Arguments[ \t]{0,8}:/i
const BLOCK_HINT = /(?:^|\n)[ \t]{0,64}(?:args|data|Request Arguments|Raw Call Arguments)[ \t]{0,8}:/i
// Any run of 130+ hex digits (a 65-byte signature is 130; calldata, raw transactions, revert blobs are longer).
const HEX_RUN = /[0-9a-f]{130,}/gi
const HEX_RUN_0X = /0x[0-9a-f]{130,}/gi
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

const scrubField = (s) => (typeof s === "string" ? redactSecretLiterals(s) : s)

/** The text redactError starts from: name, short message, revert reason, viem's URL/Status/Details lines. */
function composeErrorText(err) {
  if (err === null || err === undefined) return String(err)
  // [A93 R2-1] Every text read from the error is scrubbed WHOLE, as it came, before a line is dropped or folded (a key
  // split over two lines would lose its second half to the line filter below, or become `half half` in oneLine) and
  // before redactUrl's decoder folds an escape the key itself holds.
  if (typeof err !== "object") return typeof err === "string" ? scrubField(err) : safeString(err)
  const name = readString(err, "name")
  const short = scrubField(readString(err, "shortMessage"))
  const message = scrubField(readString(err, "message"))
  const nl = message ? message.indexOf("\n") : -1
  const head = short || (message ? (nl === -1 ? message : message.slice(0, nl)) : "")
  if (!head) return safeString(err)
  let first = oneLine(head, LINE_MAX)
  // The class says what failed (ContractFunctionExecutionError, HttpRequestError, TypeError); a plain `Error` says
  // nothing, and its existing log lines carry no prefix (chainlink-debug-read.test.mjs pins one).
  if (name && name !== "Error" && ERROR_NAME.test(name)) first = `${name}: ${first}`
  const reason = scrubField(revertReason(err))
  if (reason) {
    const r = oneLine(reason, REASON_MAX)
    if (r && !first.includes(r)) first = `${first} — reason: ${r}`
  }
  const lines = [first]
  // viem's diagnostic lines, in the message's order; a sticky match at each line start (no copy of other lines).
  for (let i = nl; i !== -1 && lines.length <= MAX_KEPT_LINES; i = message.indexOf("\n", i + 1)) {
    KEPT_LINE.lastIndex = i + 1
    const key = KEPT_LINE.exec(message)
    if (key === null) continue
    const end = message.indexOf("\n", i + 1)
    let line = message.slice(i + 1, end === -1 ? message.length : end)
    if (key[1] === "function") {
      const paren = line.indexOf("(")
      if (paren !== -1) line = line.slice(0, paren)
    }
    lines.push(oneLine(line, LINE_MAX))
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
 *      or the executor's SwapFailed inner reason), then viem's `URL:`, `Status:` and `Details:` lines and [A92 S-3]
 *      its Contract Call `address:` line and `function:` name (cut at the parenthesis), in the message's order;
 *   2. every URL redaction (redactUrl);
 *   3. the scrub: `args:` / `data:` lines and Request / Raw Call Arguments blocks removed, any run of 130+ hex
 *      digits replaced by `<hex N>`;
 *   4. [A93 R2-1] every configured secret replaced by `<redacted>` (redactSecretLiterals) — the last step that changes
 *      what the text says (every text read from the error — a string, `shortMessage`, `message`, the revert reason —
 *      is also scrubbed whole, as read, before step 1 drops or folds a line and before redactUrl's decoder runs);
 *   5. the cap: ERROR_TEXT_MAX (600) characters, or `max` when smaller, ending with `…[truncated N chars]`. The cap only
 *      removes characters; a scrub after it could no longer recognise a secret the cap had cut in half.
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
    out = redactSecretLiterals(dropBlocks(redactUrlAndHex(text)).replace(HEX_RUN, (m) => `<hex ${m.length}>`))
  } catch {
    /* unprintable */
  }
  return capText(out, cap, cut)
}

const OPEN_OR_CLOSE_TAG = /<(\/?)([a-z][a-z0-9-]{0,15})(?:\s[^<>]{0,2048})?>/gi

/**
 * A Telegram HTML text cut to at most `max` characters, ending with the marker; an alert is never dropped for its
 * length. The cut never lands inside a tag or an entity (every `&` in a Telegram HTML text opens one), and each tag
 * left open is closed: Telegram refuses an unbalanced text and the alert would be lost. The limit counts the HTML
 * source, which is never shorter than what Telegram counts after parsing the entities.
 * @param {unknown} text @param {number} [max]
 * @returns {string}
 */
export function capAlertText(text, max = ALERT_TEXT_MAX) {
  const s = typeof text === "string" ? text : safeString(text)
  if (s.length <= max) return s
  let keep = Math.max(0, max - truncatedMarker(s.length).length - 1)
  for (let attempt = 0; attempt < 4; attempt++) {
    const lt = s.lastIndexOf("<", keep - 1)
    if (lt !== -1 && lt > s.lastIndexOf(">", keep - 1)) keep = lt
    const amp = s.lastIndexOf("&", keep - 1)
    if (amp !== -1 && amp > s.lastIndexOf(";", keep - 1)) keep = amp
    if (keep > 0 && /[\uD800-\uDBFF]/.test(s[keep - 1])) keep--
    const head = s.slice(0, keep)
    const open = []
    for (const m of head.matchAll(OPEN_OR_CLOSE_TAG)) {
      const tag = m[2].toLowerCase()
      if (m[1] === "") open.push(tag)
      else if (open.lastIndexOf(tag) !== -1) open.splice(open.lastIndexOf(tag), 1)
    }
    const out = `${head}${open.reverse().map((t) => `</${t}>`).join("")}\n${truncatedMarker(s.length - keep)}`
    if (out.length <= max) return out
    keep = Math.max(0, keep - (out.length - max))
  }
  // Pathological nesting: plain text (tags removed, entities kept whole), then the cut.
  const plain = s.slice(0, keep).replace(/<[^<>]{0,2048}>/g, "")
  return `${plain}\n${truncatedMarker(s.length - plain.length)}`.slice(0, max)
}
