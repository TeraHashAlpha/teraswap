/**
 * [fix/v1-maintenance C5] The one regex-literal escaper for TS tests (CodeQL js/incomplete-sanitization).
 *
 * ONE pass over the backslash FIRST in the class, then every other metacharacter (`^ $ . * + ? ( ) [ ] { } |`,
 * plus `/` for regex-literal use), so no input can reintroduce an unescaped metacharacter — the backslash is
 * escaped in the same pass as the rest, never by an earlier or later replace that could undo it.
 *
 * The keeper's `contracts/order-engine/executor/redact.test.mjs` is a separate package (plain Node, no `@/`
 * alias) and keeps its own copy of the same rule.
 */
export const escapeRegExp = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
