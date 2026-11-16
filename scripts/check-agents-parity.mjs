#!/usr/bin/env node
/**
 * Drift guard between CLAUDE.md and AGENTS.md.
 *
 * Grok Build (and any non-Claude coding agent) reads AGENTS.md, not CLAUDE.md, so the hard rules in
 * AGENTS.md are a hand-copied excerpt of CLAUDE.md. This script fails CI when the hand-written RULES of
 * CLAUDE.md change without a matching human review of AGENTS.md, by pinning a sha256 inside a
 * `<!-- claude-md-sha256: ... -->` comment on AGENTS.md's first line.
 *
 * WHAT IS HASHED: CLAUDE.md with the generated state block removed, markers included (everything from
 * `<!-- state:begin -->` through `<!-- state:end -->`, the same markers scripts/gen-claude-state.mjs writes).
 * That block is regenerated whenever an ADR, workflow or contract row is added, so hashing it made every
 * pair of open PRs conflict on AGENTS.md line 1. Regenerating the block therefore never moves the pin.
 * A rule hand-written inside the markers cannot slip past it: `gen-claude-state.mjs --check` (lint job)
 * fails when the block differs from what it generates. A missing, duplicated or reversed marker fails
 * loudly (exit 1), in check and in --write; the script never falls back to hashing the whole file.
 *
 * The hash is never hand-typed — run `node scripts/check-agents-parity.mjs --write` after reviewing and
 * updating AGENTS.md to regenerate it.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md')
const AGENTS_MD = path.join(ROOT, 'AGENTS.md')
// Must equal BEGIN/END exported by scripts/gen-claude-state.mjs (a test pins that).
const STATE_BEGIN = '<!-- state:begin -->'
const STATE_END = '<!-- state:end -->'
const SHA_LINE = /^<!-- claude-md-sha256: ([0-9a-f]{64}|PENDING) -->$/

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function die(lines) {
  for (const l of lines) console.error(l)
  process.exit(1)
}

/** CLAUDE.md minus the generated block (markers included). Exits 1 unless there is exactly one well-ordered pair. */
function withoutStateBlock(content) {
  const count = (needle) => content.split(needle).length - 1
  const nb = count(STATE_BEGIN)
  const ne = count(STATE_END)
  if (nb !== 1 || ne !== 1) {
    die([
      `CLAUDE.md must contain exactly one ${STATE_BEGIN} and one ${STATE_END} (found ${nb} and ${ne}).`,
      'The generated state block is excluded from the pin; without its markers the pin cannot be computed.',
      'Restore the markers, then run: node scripts/gen-claude-state.mjs --write',
    ])
  }
  const b = content.indexOf(STATE_BEGIN)
  const e = content.indexOf(STATE_END)
  if (e < b) die([`CLAUDE.md has ${STATE_END} before ${STATE_BEGIN}; the state block markers are reversed.`])
  return content.slice(0, b) + content.slice(e + STATE_END.length)
}

function readAgentsShaLine(agentsContent) {
  const firstLine = agentsContent.split('\n', 1)[0]
  const match = firstLine.match(SHA_LINE)
  if (!match) {
    console.error('AGENTS.md must start with a `<!-- claude-md-sha256: ... -->` comment line.')
    console.error(`First line was: ${JSON.stringify(firstLine)}`)
    process.exit(1)
  }
  return { firstLine, hash: match[1] }
}

const claudeContent = readFileSync(CLAUDE_MD, 'utf8')
const expected = sha256(withoutStateBlock(claudeContent))

const agentsContent = readFileSync(AGENTS_MD, 'utf8')
const { firstLine, hash: actual } = readAgentsShaLine(agentsContent)

const write = process.argv.includes('--write')

if (write) {
  const updatedLine = `<!-- claude-md-sha256: ${expected} -->`
  const updated = agentsContent.replace(firstLine, updatedLine)
  writeFileSync(AGENTS_MD, updated)
  console.log(`AGENTS.md sha256 pin written: ${expected} (len=${expected.length})`)
  process.exit(0)
}

if (actual !== expected) {
  console.error('AGENTS.md is out of sync with CLAUDE.md (outside its generated state block).')
  console.error(`  expected (computed from CLAUDE.md now): ${expected} (len=${expected.length})`)
  console.error(`  actual   (pinned in AGENTS.md):          ${actual} (len=${actual.length})`)
  console.error(`  CLAUDE.md length: ${claudeContent.length} bytes (hashed without the generated state block)`)
  console.error('The hand-written rules of CLAUDE.md changed since AGENTS.md was last reviewed. Review AGENTS.md for drift, then run:')
  console.error('  node scripts/check-agents-parity.mjs --write')
  process.exit(1)
}

console.log(`AGENTS.md parity OK: ${actual} (len=${actual.length})`)
