/**
 * [fix/executor-alert-masking-rpc-auth] The ONE place keeper text is made safe for a log line or a
 * Telegram alert. INC-2026-10-30-001: the Base keeper's balance-read alert interpolated viem's
 * `err.message`, whose `URL:` line carries the provider key in its path (`…/v2/<key>`), and posted
 * the full keyed RPC URL to Telegram.
 *
 * redactUrl(text)  — every URL keeps scheme + host[:port] (the operator still sees WHICH provider)
 *                    and loses userinfo, path, query and fragment: `https://host/REDACTED`.
 * redactError(err) — the error's text (`message`, which is where viem puts `URL:` and `Details:`),
 *                    through redactUrl, optionally truncated AFTER redaction (a slice taken first
 *                    could cut the URL into a shape the patterns no longer see).
 *
 * Which URLs, deliberately broad (over-redaction costs a lookup, a leak costs a key rotation):
 *   1. anything with a scheme (http, https, ws, wss, custom; any case) — userinfo included; the one
 *      exception is `file://` (a stack-trace frame, so a redacted stack keeps its frames);
 *   2. a schemeless `host:port/…` (`127.0.0.1:8545/v2/<key>`, `[::1]:8545/…`);
 *   3. a schemeless dotted host with an alphabetic TLD followed by a path (`provider.example/v2/<key>`).
 * A bare host (`https://basescan.org`, `api.example.com`) carries no secret and is left alone, so
 * a version string like `viem@2.47.10` is never touched (no alphabetic TLD).
 *
 * chain-verify.js keeps its own STRICTER `redactUrls` (whole URL → `<redacted-url>`, plus long hex
 * runs) for its boot refusals; that is a superset of this one and is pinned by its own tests.
 *
 * Every quantifier is bounded or a single pass over a negated class — linear in the input, no
 * nested repetition (a redactor that backtracks inside an alert path is a denial of service).
 */

export const REDACTED = "/REDACTED"

/**
 * Block-explorer hosts whose links the keeper's OWN formatters put in alerts (event-watcher.js
 * EXPLORER_BY_CHAIN — pinned by redact.test.mjs). Only sendTelegramAlert's final pass passes this
 * list; a link to one of these hosts is a public tx link, never a credential. A URL with userinfo
 * is redacted even on an allowed host.
 */
export const ALERT_LINK_HOSTS = Object.freeze(["etherscan.io", "sepolia.etherscan.io", "basescan.org", "arbiscan.io"])

const TAIL = "[^\\s\"'<>(),]*"
// [A71b S-3] No lookbehind: the leftmost match wins. [A71 L-4] had required "the previous character
// cannot be part of a scheme" (so `rpc_https://` matched, `_` not being one), but a URL glued to 27+
// scheme characters — a 0x address (42 of them) written straight in front of it — then had NO valid
// start at all (the scheme is capped at 31, every later start is preceded by a scheme character) and
// passed untouched. Without the boundary the scheme is simply the last <= 31 scheme characters before
// `://`; whatever precedes them is left as it was, and the URL itself is always redacted. Bounded
// quantifier, one pass: at most 31 characters are tried per start, so the cost stays linear.
const SCHEME_URL = new RegExp(`([a-z][a-z0-9+.-]{0,30})://(${TAIL})`, "gi")
// [A71 L-4] JSON-escaped slashes (`https:\/\/host\/v2\/<key>`, also double-escaped) hid the URL from
// every pattern below; they are normalised to `/` first.
const ESCAPED_SLASH = /\\+\//g
// [A71b S-3] Other encodings of the same slash hid it just as well: percent-encoded (`%2F`, also
// double-encoded `%252F`), a JSON unicode / hex escape (`\u002f`, `\x2f`), an HTML entity (`&#x2F;`,
// `&#47;`, `&sol;`). They are decoded to `/` before anything else looks at the text. The backslash
// forms need the backslash, so a plain `0x2f` is never touched. Over-decoding only ever over-redacts.
const ENCODED_SLASH = /%(?:25){0,4}2f|\\+u002f|\\+x2f|&#x0{0,8}2f;|&#0{0,8}47;|&sol;/gi
// The scheme's own colon, encoded (`https%3A%2F%2F…`): decoded only in front of `//`, so a stray
// `%3A` elsewhere in an error text is not rewritten.
const ENCODED_COLON = /%(?:25){0,4}3a(?=\/\/)|\\+u003a(?=\/\/)|\\+x3a(?=\/\/)|&#x0{0,8}3a;(?=\/\/)|&#0{0,8}58;(?=\/\/)|&colon;(?=\/\/)/gi
// Lookbehind: only at a token start, so neither pattern re-enters a URL pattern 1 already handled.
const HOSTPORT_PATH = new RegExp(
  `(?<![\\w/:.@-])((?:\\[[0-9a-f:.]{2,45}\\]|[a-z0-9_.-]{1,255}):\\d{1,5})[/?#]${TAIL}`,
  "gi",
)
const HOST_PATH = new RegExp(`(?<![\\w/:.@-])((?:[a-z0-9_-]{1,63}\\.){1,8}[a-z]{2,24})[/?#]${TAIL}`, "gi")

function hostOf(hostPort) {
  if (hostPort.startsWith("[")) return hostPort.slice(0, hostPort.indexOf("]") + 1)
  const colon = hostPort.lastIndexOf(":")
  return colon === -1 ? hostPort : hostPort.slice(0, colon)
}

/**
 * @param {unknown} text
 * @param {{ allowHosts?: readonly string[] }} [opts] — hosts whose path-bearing links survive
 *   (sendTelegramAlert passes ALERT_LINK_HOSTS; nothing else should)
 * @returns {string}
 */
export function redactUrl(text, { allowHosts = [] } = {}) {
  const allow = new Set(allowHosts.map((h) => h.toLowerCase()))
  return String(text)
    .replace(ESCAPED_SLASH, "/")
    .replace(ENCODED_SLASH, "/")
    .replace(ENCODED_COLON, ":")
    .replace(SCHEME_URL, (match, scheme, rest) => {
      // A `file:///…` frame in a stack trace is a local path, not an endpoint — keep the frames.
      if (scheme.toLowerCase() === "file") return match
      const end = rest.search(/[/?#]/)
      const authority = end === -1 ? rest : rest.slice(0, end)
      const tail = end === -1 ? "" : rest.slice(end)
      const at = authority.lastIndexOf("@")
      const hostPort = at === -1 ? authority : authority.slice(at + 1)
      if (at === -1 && (tail === "" || tail === "/")) return match
      if (at === -1 && allow.has(hostOf(hostPort).toLowerCase())) return match
      return `${scheme}://${hostPort}${REDACTED}`
    })
    .replace(HOSTPORT_PATH, (_m, hostPort) => `${hostPort}${REDACTED}`)
    .replace(HOST_PATH, (_m, host) => `${host}${REDACTED}`)
}

/**
 * The printable text of an error, redacted. Never throws.
 * @param {unknown} err — an Error (viem or not), a string, or anything else
 * @param {{ max?: number }} [opts] — truncate to `max` characters AFTER redaction
 * @returns {string}
 */
export function redactError(err, { max } = {}) {
  let text
  try {
    if (err == null || typeof err !== "object") text = String(err)
    else if (typeof err.message === "string" && err.message) text = err.message
    else if (typeof err.shortMessage === "string" && err.shortMessage) text = err.shortMessage
    else text = String(err)
  } catch {
    text = "[unprintable error]"
  }
  const out = redactUrl(text)
  return Number.isInteger(max) && max > 0 && out.length > max ? out.slice(0, max) : out
}
