#!/usr/bin/env node
/**
 * Fails on bash-4-only syntax in any tracked .sh file. macOS ships bash 3.2.57 and both `bash`
 * and `/usr/bin/env bash` resolve to it — a script using ${var,,}, declare -A, mapfile/readarray,
 * or `shopt -s globstar` breaks the moment a contributor runs it locally. See CLAUDE.md
 * "Bash compatibility" / AGENTS.md.
 *
 * Comments are stripped before matching: a comment that merely mentions one of these constructs
 * (e.g. explaining why the code uses `tr` instead) is not a violation.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const VIOLATIONS = [
  { name: '${var,,} / ${var^^} (bash4 case conversion)', regex: /\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?[,^]{1,2}[^}]*\}/ },
  { name: 'declare -A (bash4 associative array)', regex: /\bdeclare\s+-[a-zA-Z]*A[a-zA-Z]*\b/ },
  { name: 'mapfile (bash4 builtin)', regex: /\bmapfile\b/ },
  { name: 'readarray (bash4 builtin)', regex: /\breadarray\b/ },
  { name: 'shopt -s globstar (bash4 recursive glob)', regex: /\bshopt\s+-s\s+globstar\b/ },
]

function listTrackedShFiles() {
  const out = execFileSync('git', ['ls-files', '*.sh'], { encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

// Strips '#'-to-end-of-line comments, but not '#' inside a single- or double-quoted string, and
// not a shebang's own leading '#!' (harmless either way — it never matches a violation regex).
function stripComments(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i)
    }
  }
  return line
}

function checkFile(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const findings = []
  lines.forEach((rawLine, idx) => {
    const code = stripComments(rawLine)
    for (const violation of VIOLATIONS) {
      if (violation.regex.test(code)) {
        findings.push({ file, line: idx + 1, name: violation.name, text: code.trim() })
      }
    }
  })
  return findings
}

const files = listTrackedShFiles()
const allFindings = files.flatMap(checkFile)

if (allFindings.length > 0) {
  console.error('Bash-4-only syntax found (breaks macOS stock bash 3.2.57):')
  for (const f of allFindings) {
    console.error(`  ${f.file}:${f.line}  ${f.name}  —  ${f.text}`)
  }
  process.exit(1)
}

console.log(`check-bash3-compat OK: ${files.length} tracked .sh file(s), 0 violations.`)
