#!/usr/bin/env node
// goal-lint — mechanical checks for a `/goal` paste (docs/Prompts/_PROMPT-TEMPLATE.md §1, §1b, §6).
//
//   node scripts/goal-lint.mjs FILE      exit 0 = clean, 1 = violations (listed), 2 = usage/IO error
//   node scripts/goal-lint.mjs -         the goal on stdin; `/dev/stdin` means the same (file descriptor 0, never the path)
//
// Rules (each violation prints `FAIL <rule>: <detail>`):
//   length          more than 4000 BYTES (UTF-8, counted exactly as `wc -c` does: "·", "→", "—" are 2-3 bytes)
//   control-line    the first non-empty line does not start with `CONTROL:` — after dropping what a paste adds in front of it
//                   (BOM, NBSP, zero-width spaces, leading spaces, bracketed-paste ESC markers, "> " quote marks, an
//                   opening ``` / ~~~ fence line, a "/goal " prefix). A goal with no CONTROL header at all still fails.
//   exit-clause     no `Exit =` anywhere
//   banned-phrase   contains "no Monitor" or "CI-poll" (case-insensitive)
//   risky-command   names pm2, ssh or `cast send` outside a Do-NOT line
//                   (case-sensitive lowercase tokens, so the prose "SSH-signed" is fine)
//   audit-verdict   an audit goal (`READ-ONLY` on the CONTROL line) lacks "ANY verdict"
//
// A "Do-NOT line" is a line that starts (after optional bullet / number / checkbox / quote / bold / heading marks) with
// "Do NOT", "Do-NOT" or "Do not" ("- Do NOT …", "1. Do NOT …", "- [ ] Do NOT …") — or any line inside a section whose
// heading starts that way, or inside the list that follows a bare "Do NOT:" label line.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MAX_BYTES = 4000
export const MAX_CHARS = MAX_BYTES // old name

const MARKS = String.raw`(?:(?:[-*+>]|\d+[.)])\s*(?:\[[ xX]\]\s*)?)*`
const DO_NOT_START = new RegExp(String.raw`^\s*${MARKS}(?:\*\*)?(?:#+\s*)?do[ -]not\b`, 'i')
const DO_NOT_LABEL = new RegExp(String.raw`^\s*${MARKS}(?:\*\*)?(?:#+\s*)?do[ -]not\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$`, 'i')
const LIST_ITEM = /^\s*(?:[-*+>]|\d+[.)])\s+/
const INDENTED = /^\s{2,}\S/
const HEADING = /^\s*#{1,6}\s/
const RISKY = [
  { name: 'pm2', re: /\bpm2\b/ },
  { name: 'ssh', re: /\bssh\b/ },
  { name: 'cast send', re: /\bcast send\b/ },
]
const BANNED = [/no monitor/i, /ci-poll/i]

// What pasting a goal into a session (rather than reading the file) puts in front of the CONTROL header.
const BRACKETED_PASTE = /\x1b\[20[01]~/g
const INVISIBLE = /[\u00a0\u200b-\u200d\u2060\ufeff]/g
const FENCE = /^(?:`{3,}|~{3,})/
const QUOTE_MARKS = /^(?:>\s*)+/
const GOAL_PREFIX = /^\/goal\s+/

/** The first line with content, with paste decoration removed. Used for the CONTROL check only (never for sizes). */
export function firstControlCandidate(text) {
  const lines = text.replace(BRACKETED_PASTE, '').split(/\r\n|\r|\n/)
  for (const raw of lines) {
    const line = raw.replace(INVISIBLE, ' ').trim()
    if (line === '' || FENCE.test(line)) continue
    return line.replace(QUOTE_MARKS, '').replace(GOAL_PREFIX, '').trim()
  }
  return ''
}

/** @param {string|Buffer} input @returns {{rule: string, detail: string}[]} */
export function lintGoal(input) {
  const out = []
  const bytes = Buffer.isBuffer(input) ? input.length : Buffer.byteLength(input, 'utf8')
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : input
  const lines = text.split('\n')
  const first = firstControlCandidate(text)

  if (bytes > MAX_BYTES) {
    out.push({ rule: 'length', detail: `${bytes} bytes > ${MAX_BYTES}` })
  }
  if (!first.startsWith('CONTROL:')) {
    out.push({ rule: 'control-line', detail: 'first non-empty line must start with "CONTROL:"' })
  }
  if (!text.includes('Exit =')) {
    out.push({ rule: 'exit-clause', detail: 'no "Exit =" clause' })
  }
  for (const re of BANNED) {
    const m = text.match(re)
    if (m) out.push({ rule: 'banned-phrase', detail: `contains "${m[0]}"` })
  }

  let inDoNotSection = false
  let inDoNotList = false // after a bare "Do NOT:" label: its bullets, numbered items and indented continuations
  lines.forEach((line, i) => {
    if (HEADING.test(line)) { inDoNotSection = DO_NOT_START.test(line); inDoNotList = false }
    else if (DO_NOT_LABEL.test(line)) inDoNotList = true
    else if (inDoNotList && line.trim() !== '' && !LIST_ITEM.test(line) && !INDENTED.test(line)) inDoNotList = false
    const exempt = inDoNotSection || inDoNotList || DO_NOT_START.test(line)
    if (exempt) return
    for (const { name, re } of RISKY) {
      if (re.test(line)) {
        out.push({ rule: 'risky-command', detail: `line ${i + 1} names ${name} outside a Do-NOT line` })
      }
    }
  })

  if (/READ-ONLY/.test(first) && !text.includes('ANY verdict')) {
    out.push({ rule: 'audit-verdict', detail: 'audit goal (READ-ONLY) must say the report is the exit on "ANY verdict"' })
  }
  return out
}

// "The goal is on stdin". Read file descriptor 0 for these, never the path: on Linux /dev/stdin is a link to /proc/self/fd/0,
// and opening that fails with ENXIO when stdin is a socket, which is what a Node parent (spawnSync, a hook runner) gives its
// child. macOS duplicates the descriptor instead, so the path only ever worked there.
const STDIN_ARGS = new Set(['-', '/dev/stdin'])

function main(argv) {
  const file = argv[2]
  if (!file || argv.length > 3) {
    console.error('usage: node scripts/goal-lint.mjs FILE   (- or /dev/stdin reads stdin)')
    return 2
  }
  let text // a Buffer: the length rule counts the file's bytes exactly as `wc -c` does
  try {
    text = readFileSync(STDIN_ARGS.has(file) ? 0 : file)
  } catch (e) {
    console.error(`goal-lint: cannot read ${file}: ${e.code ?? e.message}`)
    return 2
  }
  const violations = lintGoal(text)
  for (const v of violations) console.log(`FAIL ${v.rule}: ${v.detail}`)
  console.log(violations.length === 0 ? `OK ${text.length} bytes` : `${violations.length} violation(s)`)
  return violations.length === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv))
}
