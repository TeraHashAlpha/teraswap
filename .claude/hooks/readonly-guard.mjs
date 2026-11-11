#!/usr/bin/env node
// PreToolUse hook (matcher: Bash) for the read-only agents (recon, auditor).
// Refuses `git` commands that write history/refs/remotes and every `gh` command that is not a known read.
// Protocol (https://code.claude.com/docs/en/hooks): tool call JSON on stdin; exit 2 + stderr = block.
// Fails CLOSED: any parse/IO error blocks. This is a guard against accidents and drift, not a sandbox —
// `bash -c`, `eval` and aliases can still evade it; the agents' tool lists (no Edit/Write) are the other half.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const GIT_WRITES = new Set([
  'commit', 'push', 'merge', 'rebase', 'cherry-pick', 'revert', 'tag', 'am', 'apply', 'reset',
  'commit-tree', 'update-ref', 'fast-import', 'notes', 'replace', 'stash',
])
// git global options that take a separate value.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix'])
const GH_READ = [
  ['pr', 'view'], ['pr', 'diff'], ['pr', 'list'], ['pr', 'status'], ['pr', 'checkout'],
  ['issue', 'view'], ['issue', 'list'], ['repo', 'view'], ['auth', 'status'], ['codeql'],
  ['run', 'view'], ['run', 'list'], ['release', 'view'], ['release', 'list'],
]
const API_WRITE_FLAG = /^(-X\S*|--method(=.*)?|-f|-F|--field|--raw-field|--input)$/

/** Split a command into token lists, one per simple command (separators, subshells, quotes all flatten). */
function simpleCommands(command) {
  return command
    .replace(/\$\(|`/g, ';')
    .split(/&&|\|\||\|&|;|\||&|\n|\(|\)/)
    .map((s) => s.replace(/["']/g, ' ').trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length > 0)
}

function stripEnvAssignments(tokens) {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  return tokens.slice(i)
}

function ghDecision(rest) {
  // rest = tokens after `gh`; skip global flags (-R/--repo value).
  const t = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-R' || rest[i] === '--repo') { i++; continue }
    if (rest[i].startsWith('--repo=')) continue
    t.push(rest[i])
  }
  if (t[0] === 'api') {
    const bad = t.slice(1).find((x) => API_WRITE_FLAG.test(x))
    return bad ? `gh api write flag "${bad}"` : null
  }
  const ok = GH_READ.some(([a, b]) => t[0] === a && (b === undefined || t[1] === b))
  return ok ? null : `gh ${t.slice(0, 2).join(' ')} is not on the read-only list`
}

/** @returns {string|null} a refusal reason, or null if the command may run */
export function decide(command) {
  for (const raw of simpleCommands(command)) {
    const tokens = stripEnvAssignments(raw)
    // find `git` / `gh` anywhere in the simple command (covers `env X=1 git ...`, `sudo git ...`, `xargs git ...`)
    for (let i = 0; i < tokens.length; i++) {
      const base = tokens[i].split('/').pop()
      if (base === 'git') {
        let j = i + 1
        while (j < tokens.length && tokens[j].startsWith('-')) j += GIT_VALUE_OPTS.has(tokens[j]) ? 2 : 1
        const sub = tokens[j]
        if (sub && GIT_WRITES.has(sub)) return `git ${sub} is not allowed for a read-only agent`
        if (sub === 'branch' && tokens.slice(j + 1).some((x) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)/.test(x))) return 'git branch write is not allowed'
        if (sub === 'remote' && tokens.slice(j + 1).some((x) => /^(add|remove|rm|rename|set-url|set-head)$/.test(x))) return 'git remote write is not allowed'
      }
      if (base === 'gh') {
        const why = ghDecision(tokens.slice(i + 1))
        if (why) return why
      }
    }
  }
  return null
}

function main() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    const command = input?.tool_input?.command
    if (typeof command !== 'string') throw new Error('no tool_input.command')
    const why = decide(command)
    if (why) {
      process.stderr.write(`readonly-guard: refused — ${why}. This agent reports; it never commits, pushes or writes to GitHub.\n`)
      process.exit(2)
    }
  } catch (e) {
    process.stderr.write(`readonly-guard: failing closed (${e.message})\n`)
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
