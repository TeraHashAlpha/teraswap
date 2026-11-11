#!/usr/bin/env node
// PreToolUse hook (matcher: Bash) registered in .claude/settings.json for EVERY session; it only acts when the hook
// input says the call comes from a read-only agent (`agent_type` = recon or auditor — the field the hooks docs give:
// "Present when the session uses --agent or the hook fires inside a subagent"; PreToolUse has no agent-type matcher,
// so the script keys on it). Audit A77 H-4 / M-1 / M-2: it used to live in agent frontmatter and was a flattened regex.
// It reuses shell-parse.mjs (quotes, backslashes, env/command/VAR=x, absolute paths, sh -c, eval, xargs, npx X) and
// refuses everything that writes history, refs, the index or GitHub. A quoted mention ("git push" in a grep pattern or
// commit message) is not a command and is allowed.
// Protocol (https://code.claude.com/docs/en/hooks): JSON on stdin; exit 2 + stderr = block. Fails CLOSED (settings.json
// adds `|| exit 2` + onFailure block: any other exit code or a crash would let the call proceed).
// Not a sandbox: Bash redirects (`echo x > f`), `sed -i`, scripts and interpreters can still write — those agents have
// no Edit/Write tools and the rest is prose. See "What this cannot stop" in docs/Runbooks/agent-harness.md.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { inspect } from './shell-parse.mjs'
import { ghApiWriteReason, ghParts, gitParts } from './command-guard.mjs'

export const READONLY_AGENT_TYPES = new Set(['recon', 'auditor'])

const GIT_WRITES = new Set([
  'commit', 'push', 'pull', 'am', 'cherry-pick', 'rebase', 'revert', 'tag', 'config', 'clean', 'restore', 'reset', 'apply',
  'commit-tree', 'update-ref', 'fast-import', 'notes', 'replace', 'stash', 'add', 'rm', 'mv', 'gc', 'prune', 'filter-branch', 'init',
  'send-pack', 'http-push',
])
const GH_READ = [
  ['pr', 'view'], ['pr', 'diff'], ['pr', 'list'], ['pr', 'status'], ['pr', 'checks'],
  ['issue', 'view'], ['issue', 'list'], ['issue', 'status'], ['repo', 'view'], ['auth', 'status'],
  ['run', 'view'], ['run', 'list'], ['release', 'view'], ['release', 'list'], ['workflow', 'view'], ['workflow', 'list'],
  ['label', 'list'], ['search'], ['codeql'], ['version'], ['help'], ['status'],
]
const BRANCH_LIST_FLAGS = new Set(['-l', '--list', '-a', '--all', '-r', '--remotes', '--show-current', '-v', '-vv', '--verbose', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'])
const FETCH_VALUED = new Set(['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '--upload-pack', '--refmap', '-o', '--server-option', '--negotiation-tip'])

/** Refusal reason for one effective git command, or null. */
function gitReason(c) {
  const { sub, args } = gitParts(c.argv)
  if (sub === undefined) return null
  if (sub === 'stash' && (args[0] === 'list' || args[0] === 'show')) return null
  if (GIT_WRITES.has(sub)) return `git ${sub} writes history, refs or the index`
  if (sub === 'merge') return args.includes('--no-commit') && !args.includes('--commit') ? null : 'git merge without --no-commit creates a commit'
  if (sub === 'checkout') {
    if (args.some((t) => /^(-[a-zA-Z]*[bB][a-zA-Z]*|--orphan|--force-create|-t|--track)$/.test(t))) return 'git checkout -b/-B creates a branch'
    if (args.includes('--')) return 'git checkout -- <path> overwrites working-tree files'
    return null
  }
  if (sub === 'switch') return args.some((t) => /^(-[cC]|--create|--force-create|--orphan)$/.test(t)) ? 'git switch -c creates a branch' : null
  if (sub === 'branch') {
    if (args.some((t) => /^(-[a-zA-Z]*[dDmMcCfu][a-zA-Z]*|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description)$/.test(t) && !BRANCH_LIST_FLAGS.has(t))) return 'git branch write flag'
    const listing = args.some((t) => BRANCH_LIST_FLAGS.has(t.split('=')[0]))
    return !listing && args.some((t) => !t.startsWith('-')) ? 'git branch <name> creates a branch' : null
  }
  if (sub === 'remote') return args.some((t) => /^(add|remove|rm|rename|set-url|set-head|set-branches|prune)$/.test(t)) ? 'git remote write' : null
  if (sub === 'reflog') return args.some((t) => /^(expire|delete)$/.test(t)) ? 'git reflog expire/delete' : null
  if (sub === 'fetch') {
    const pos = []
    for (let k = 0; k < args.length; k++) {
      if (FETCH_VALUED.has(args[k])) { k++; continue }
      if (!args[k].startsWith('-')) pos.push(args[k])
    }
    return pos.slice(1).some((t) => t.includes(':')) ? 'git fetch with a src:dst refspec writes local refs' : null
  }
  return null
}

function ghReason(c) {
  const { group, action, afterGroup } = ghParts(c.argv)
  if (group === undefined) return null // `gh`, `gh --version`, `gh --help`
  if (group === 'api') {
    const why = ghApiWriteReason(afterGroup)
    return why ? `${why} — a read-only agent may only GET` : null
  }
  const ok = GH_READ.some(([a, b]) => group === a && (b === undefined || action === b))
  return ok ? null : `gh ${[group, action].filter(Boolean).join(' ')} is not on the read-only list`
}

/** @returns {string|null} a refusal reason, or null if a read-only agent may run it. Throws on unparseable input. */
export function decide(command) {
  const { cmds, problems } = inspect(command)
  if (problems.length > 0) return problems[0]
  for (const c of cmds) {
    const why = c.base === 'git' ? gitReason(c) : c.base === 'gh' ? ghReason(c) : null
    if (why) return why
  }
  return null
}

/** `recon`, `project:recon`, `Recon` -> true. Anything else (implementer, Explore, no agent at all) -> false. */
export function isReadOnlyAgent(agentType) {
  if (typeof agentType !== 'string') return false
  const name = agentType.toLowerCase().split(':').pop().trim()
  return READONLY_AGENT_TYPES.has(name)
}

function main() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    const command = input?.tool_input?.command
    if (typeof command !== 'string') throw new Error('no tool_input.command')
    if (!isReadOnlyAgent(input.agent_type)) return
    const why = decide(command)
    if (why) {
      process.stderr.write(`readonly-guard: refused — ${why}. The ${input.agent_type} agent reports; it never commits, pushes or writes to GitHub.\n`)
      process.exit(2)
    }
  } catch (e) {
    process.stderr.write(`readonly-guard: failing closed (${e.message})\n`)
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
