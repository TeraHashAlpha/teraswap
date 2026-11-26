#!/usr/bin/env node
/**
 * Run after `next build`. Fails when the built v1 stylesheet is not the v1 stylesheet.
 *
 * Seen in the PR #719 audit, on a stale Next install: the build succeeded, but the v1 stylesheet was 34,265 bytes
 * instead of 65,960 because the v1 Tailwind pass had compiled v2's content. The page rendered unstyled and nothing
 * failed. Byte sizes move with every style change, so this checks which classes are in the file:
 *   - the v1 stylesheet is every built .css file that declares ANCHOR, a custom property written by hand in
 *     src/app/globals.css (so it is there even when the Tailwind pass goes wrong);
 *   - it must define every V1_ONLY utility and no V2_ONLY utility;
 *   - every V2_ONLY utility must be in some OTHER built stylesheet, so a renamed v2 class cannot leave the second
 *     rule matching nothing.
 * Markers must not be classes globals.css writes by hand: `.bg-surface-secondary` and `.text-cream` have
 * `html.light` overrides there and are present in the broken file too.
 * scripts/check-v1-css.test.mjs pins each marker to the source tree.
 *
 * Usage: node scripts/check-v1-css.mjs [static-dir]   (default: .next/static)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ANCHOR = '--particle-color:'
export const V1_ONLY = ['bg-cream-15', 'bg-surface-secondary/60']
export const V2_ONLY = ['text-v2-text', 'font-v2-mono']

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The class names a stylesheet's selectors use, unescaped. Comments, strings and url() bodies are not selectors. */
export function classNames(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|url\([^)"']*\)/g, ' ')
  const names = new Set()
  for (const m of bare.matchAll(/\.((?:\\.|[A-Za-z_-])(?:\\.|[\w-])*)/g)) names.add(m[1].replace(/\\(.)/g, '$1'))
  return names
}

function stylesheets(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.css') && statSync(path.join(dir, f)).isFile())
    .sort()
}

/** @returns {{ failures: string[], ok: string[] }} one `ok` entry per v1 stylesheet checked */
export function checkStaticDir(dir) {
  const sheets = stylesheets(dir).map((file) => {
    const css = readFileSync(path.join(dir, file), 'utf8')
    return { file, bytes: Buffer.byteLength(css), isV1: css.includes(ANCHOR), classes: classNames(css) }
  })
  if (sheets.length === 0) return { failures: [`no built stylesheet under ${dir} (run npm run build first)`], ok: [] }
  const v1 = sheets.filter((s) => s.isV1)
  if (v1.length === 0) {
    return { failures: [`no stylesheet declares ${ANCHOR} (src/app/globals.css), so the v1 stylesheet cannot be found`], ok: [] }
  }
  const failures = []
  for (const s of v1) {
    for (const m of V1_ONLY) if (!s.classes.has(m)) failures.push(`${s.file} lacks the v1-only class .${m} (${s.bytes} bytes)`)
    for (const m of V2_ONLY) if (s.classes.has(m)) failures.push(`${s.file} contains the v2-only class .${m} (${s.bytes} bytes)`)
  }
  for (const m of V2_ONLY) {
    if (!sheets.some((s) => !s.isV1 && s.classes.has(m))) {
      failures.push(`stale marker: .${m} is in no other built stylesheet; pick a v2-only class that v2 still uses`)
    }
  }
  return { failures, ok: v1.map((s) => `${s.file} (${s.bytes} bytes)`) }
}

export function main(argv = process.argv.slice(2), io = process) {
  const { failures, ok } = checkStaticDir(path.resolve(argv[0] ?? path.join(ROOT, '.next/static')))
  if (failures.length > 0) {
    io.stderr.write(failures.map((f) => `check-v1-css FAIL: ${f}\n`).join(''))
    return 1
  }
  const names = (list) => list.map((m) => `.${m}`).join(' ')
  io.stdout.write(`check-v1-css OK: ${ok.join(', ')} has ${names(V1_ONLY)} and none of ${names(V2_ONLY)}\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // set, don't exit: a pipe's pending writes are dropped by process.exit
  process.exitCode = main()
}
