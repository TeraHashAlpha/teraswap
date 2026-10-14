/**
 * Shared log-injection barrier (CodeQL js/log-injection).
 *
 * Removes CR/LF (and every other C0 control + DEL) from a value before it is interpolated into a
 * `console.*` line, so attacker-influenced text cannot forge a second log entry. Output is capped
 * at `max` characters.
 *
 * The CR/LF `.replace(/[\r\n]/g, '')` is deliberately written INLINE, with a literal regex and an
 * EMPTY replacement, in this function body: CodeQL's js/log-injection `StringReplaceSanitizer`
 * only treats `replace(<regex matching \n>, "")` as a barrier — a non-empty replacement (e.g. ' ')
 * is NOT recognised. Verify with scripts/codeql-local.sh.
 *
 * Log lines only — never use this on a value that is stored, keyed or compared.
 */
export function forLog(value: unknown, max = 200): string {
  const text = String(value)
    .replace(/[\r\n]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
  return text.length > max ? text.slice(0, max) : text
}
