/**
 * Shared log-injection barrier (CodeQL js/log-injection).
 *
 * Neutralises CR/LF (and every other C0 control + DEL) in a value before it is interpolated into a
 * `console.*` line, so attacker-influenced text cannot forge a second log entry. Output is capped
 * at `max` characters.
 *
 * The CR/LF `.replace(/[\r\n]/g, ' ')` is deliberately written INLINE, with a literal regex, in
 * this function body: CodeQL's sanitizer model only recognises that exact shape.
 *
 * Log lines only — never use this on a value that is stored, keyed or compared.
 */
export function forLog(value: unknown, max = 200): string {
  const text = String(value)
    .replace(/[\r\n]/g, ' ')
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\x00-\x1f\x7f]/g, '')
  return text.length > max ? text.slice(0, max) : text
}
