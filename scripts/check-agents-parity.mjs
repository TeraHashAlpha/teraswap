#!/usr/bin/env node
/**
 * Drift guard between CLAUDE.md and AGENTS.md.
 *
 * Grok Build (and any non-Claude coding agent) reads AGENTS.md, not CLAUDE.md, so the hard rules in
 * AGENTS.md are a hand-copied excerpt of CLAUDE.md. This script fails CI when CLAUDE.md changes without
 * a matching human review of AGENTS.md, by pinning a sha256 of CLAUDE.md inside a
 * `<!-- claude-md-sha256: ... -->` comment on AGENTS.md's first line.
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
const SHA_LINE = /^<!-- claude-md-sha256: ([0-9a-f]{64}|PENDING) -->$/

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
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
const expected = sha256(claudeContent)

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
  console.error('AGENTS.md is out of sync with CLAUDE.md.')
  console.error(`  expected (computed from CLAUDE.md now): ${expected} (len=${expected.length})`)
  console.error(`  actual   (pinned in AGENTS.md):          ${actual} (len=${actual.length})`)
  console.error(`  CLAUDE.md length: ${claudeContent.length} bytes`)
  console.error('CLAUDE.md changed since AGENTS.md was last reviewed. Review AGENTS.md for drift, then run:')
  console.error('  node scripts/check-agents-parity.mjs --write')
  process.exit(1)
}

console.log(`AGENTS.md parity OK: ${actual} (len=${actual.length})`)
