#!/usr/bin/env node
// goal-lint — mechanical checks for a `/goal` paste (docs/Prompts/_PROMPT-TEMPLATE.md §1, §1b, §6).
//
//   node scripts/goal-lint.mjs FILE      exit 0 = clean, 1 = violations (listed), 2 = usage/IO error
//
// Rules (each violation prints `FAIL <rule>: <detail>`):
//   length          more than 4000 characters
//   control-line    line 1 does not start with `CONTROL:`
//   exit-clause     no `Exit =` anywhere
//   banned-phrase   contains "no Monitor" or "CI-poll" (case-insensitive)
//   risky-command   names pm2, ssh or `cast send` outside a Do-NOT line
//                   (case-sensitive lowercase tokens, so the prose "SSH-signed" is fine)
//   audit-verdict   an audit goal (`READ-ONLY` on the CONTROL line) lacks "ANY verdict"
//
// A "Do-NOT line" is a line that starts (after optional bullet / quote / bold / heading marks) with
// "Do NOT", "Do-NOT" or "Do not" — or any line inside a section whose heading starts that way.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MAX_CHARS = 4000

const DO_NOT_START = /^\s*(?:[-*>]\s*)*(?:\*\*)?(?:#+\s*)?do[ -]not\b/i
const HEADING = /^\s*#{1,6}\s/
const RISKY = [
  { name: 'pm2', re: /\bpm2\b/ },
  { name: 'ssh', re: /\bssh\b/ },
  { name: 'cast send', re: /\bcast send\b/ },
]
const BANNED = [/no monitor/i, /ci-poll/i]

/** @param {string} text @returns {{rule: string, detail: string}[]} */
export function lintGoal(text) {
  const out = []
  const lines = text.split('\n')

  if (text.length > MAX_CHARS) {
    out.push({ rule: 'length', detail: `${text.length} chars > ${MAX_CHARS}` })
  }
  if (!lines[0].startsWith('CONTROL:')) {
    out.push({ rule: 'control-line', detail: 'line 1 must start with "CONTROL:"' })
  }
  if (!text.includes('Exit =')) {
    out.push({ rule: 'exit-clause', detail: 'no "Exit =" clause' })
  }
  for (const re of BANNED) {
    const m = text.match(re)
    if (m) out.push({ rule: 'banned-phrase', detail: `contains "${m[0]}"` })
  }

  let inDoNotSection = false
  lines.forEach((line, i) => {
    if (HEADING.test(line)) inDoNotSection = DO_NOT_START.test(line)
    const exempt = inDoNotSection || DO_NOT_START.test(line)
    if (exempt) return
    for (const { name, re } of RISKY) {
      if (re.test(line)) {
        out.push({ rule: 'risky-command', detail: `line ${i + 1} names ${name} outside a Do-NOT line` })
      }
    }
  })

  if (/READ-ONLY/.test(lines[0]) && !text.includes('ANY verdict')) {
    out.push({ rule: 'audit-verdict', detail: 'audit goal (READ-ONLY) must say the report is the exit on "ANY verdict"' })
  }
  return out
}

function main(argv) {
  const file = argv[2]
  if (!file || argv.length > 3) {
    console.error('usage: node scripts/goal-lint.mjs FILE')
    return 2
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    console.error(`goal-lint: cannot read ${file}: ${e.code ?? e.message}`)
    return 2
  }
  const violations = lintGoal(text)
  for (const v of violations) console.log(`FAIL ${v.rule}: ${v.detail}`)
  console.log(violations.length === 0 ? `OK ${text.length} chars` : `${violations.length} violation(s)`)
  return violations.length === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv))
}
