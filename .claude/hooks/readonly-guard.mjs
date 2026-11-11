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
// A77d H-11: where a git command runs matters. `checkout --detach`, `merge` (any form but --abort/--quit) and
// `worktree remove --force` move HEAD, the index or another worktree of the checkout they run in, so they are refused
// when the effective directory (the hook's `cwd`, a leading `cd DIR &&`, `git -C DIR`) is the MAIN checkout (its `.git`
// is a directory) or cannot be determined; in a linked worktree (`.git` is a file) they stay allowed. `git fetch`
// updating remote-tracking refs and tags is by design (owner ruling). Read-only agents work in a linked worktree.
// Not a sandbox: Bash redirects (`echo x > f`), `sed -i`, scripts and interpreters can still write — those agents have
// no Edit/Write tools and the rest is prose. See "What this cannot stop" in docs/Runbooks/agent-harness.md.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EXP, inspect } from './shell-parse.mjs'
import { ghAllowReason } from './command-guard.mjs'

export const READONLY_AGENT_TYPES = new Set(['recon', 'auditor'])

// ALLOW-LIST (audit A77b M-8, M-9): a read-only agent may run only these git forms; everything else is refused.
const GIT_FREE = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'merge-base', 'name-rev', 'shortlog', 'for-each-ref', 'show-ref', 'diff-tree', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'grep', 'describe'])
const GIT_GLOBAL_OK = new Set(['--no-pager', '-P', '--no-optional-locks', '--version', '--help', '-h'])
const GIT_GLOBAL_VALUED = new Set(['-C', '--git-dir', '--work-tree'])
const BRANCH_FLAGS = new Set(['-l', '--list', '-a', '--all', '-r', '--remotes', '--show-current', '-v', '-vv', '--verbose'])
const BRANCH_VALUED = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'])
const TAG_FLAGS = new Set(['-l', '--list', '-n'])
const TAG_VALUED = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'])
const FETCH_FLAGS = new Set(['--all', '-t', '--tags', '--no-tags', '-q', '--quiet', '-v', '--verbose', '-n', '--dry-run', '--no-recurse-submodules'])
const FETCH_VALUED = new Set(['-j', '--jobs'])
// A77c H-11: a fetch that changes the repository's shape (.git/shallow) or deletes refs is not a read.
const FETCH_REFUSED = /^(--depth|--deepen|--shallow-[a-z-]+|--unshallow|--update-shallow|--prune|--prune-tags|-p|-P|--refmap|--update-head-ok|-u|--force|-f|--set-upstream)(=|$)/
// `--ff` / `--ff-only` are not here: a fast-forward moves the checked-out branch (A77c M-11).
const MERGE_FLAGS = new Set(['--no-commit', '--no-ff', '--no-edit', '--no-verify', '-q', '--quiet', '-v', '--verbose', '--no-stat', '--stat'])
const WORKTREE_ADD_FLAGS = new Set(['--detach', '--no-checkout', '-f', '--force', '-q', '--quiet'])
const CONFIG_GET = new Set(['--get', '--get-all', '--get-regexp'])
const CONFIG_SCOPE = new Set(['--local', '--global', '--system', '--worktree', '--show-origin', '--show-scope'])

/** All of `args` must be flags from `flags`, or valued flags from `valued` (`--x v` or `--x=v`), or (when allowed) positionals. */
function onlyFlags(args, flags, valued, { positionals = 'none' } = {}) {
  let positional = 0
  for (let k = 0; k < args.length; k++) {
    const t = args[k]
    if (!t.startsWith('-')) { positional++; continue }
    const name = t.split('=')[0]
    if (flags.has(t)) continue
    if (valued.has(name)) { if (!t.includes('=')) k++; continue }
    if (/^--jobs=/.test(t) || /^-j\d+$/.test(t)) continue
    return `git flag ${t}`
  }
  if (positionals === 'none' && positional > 0) return 'a positional argument'
  return null
}


// ---------------------------------------------------------------------------------------------------------------
// Where does the command run? (A77d H-11)

/** 'main' (a `.git` DIRECTORY above it), 'linked' (a `.git` FILE above it) or 'unknown' (relative path, no `.git`). */
export function checkoutKind(dir) {
  if (typeof dir !== 'string' || !dir.startsWith('/')) return 'unknown'
  let base = dir
  try { base = realpathSync(dir) } catch { /* a directory that does not exist yet: judge the string */ }
  for (let cur = base; ; cur = dirname(cur)) {
    try {
      const st = statSync(join(cur, '.git'))
      return st.isDirectory() ? 'main' : st.isFile() ? 'linked' : 'unknown'
    } catch { /* no `.git` here: keep climbing */ }
    if (cur === '/' || cur === dirname(cur)) return 'unknown'
  }
}

/** `dir` moved by one `cd`/`-C` argument; null when it cannot be known (variable, no base for a relative path). */
function moveDir(dir, target) {
  if (typeof target !== 'string' || target === '' || target.includes(EXP)) return null
  if (target === '~' || target.startsWith('~/')) return posix.normalize(join(homedir(), target.slice(1)))
  if (target.startsWith('~')) return null
  if (target.startsWith('/')) return posix.normalize(target)
  return dir ? posix.normalize(posix.join(dir, target)) : null
}

const CD_WORD = String.raw`'[^']*'|"[^"$` + '`' + String.raw`\\]*"|[^\s;&|<>()$` + '`' + String.raw`\\'"]+`
const CD_PREFIX = new RegExp(String.raw`^\s*(?:cd|pushd)\s+(?:-[LP]\s+)*(?:--\s+)?(${CD_WORD})\s*&&\s*`)

/**
 * The directory the commands of `command` start in: the hook `cwd` moved by each LEADING `cd DIR &&` (only `&&`: after
 * `cd X; …` a failed cd leaves the shell where it was). Any other `cd`/`pushd`/`popd` (a subshell, `|| cd`, inside
 * `sh -c`), `env -C`/`sudo -D`/`--chdir`, `GIT_DIR`/`GIT_WORK_TREE` makes it unknown (null).
 */
export function startDir(command, cmds, cwd) {
  let dir = typeof cwd === 'string' && cwd.startsWith('/') ? posix.normalize(cwd) : null
  let rest = String(command)
  let consumed = 0
  for (;;) {
    const m = CD_PREFIX.exec(rest)
    if (!m) break
    dir = moveDir(dir, m[1].replace(/^(['"])(.*)\1$/s, '$2'))
    rest = rest.slice(m[0].length)
    consumed++
  }
  const cds = cmds.filter((c) => ['cd', 'pushd', 'popd'].includes(c.base)).length
  if (cds !== consumed) return null
  if (/(?:^|[\s;&|(])(?:g?env|sudo|doas)\b[^;&|\n]*\s(?:-C|-D|--chdir)(?:[\s=]|$)/.test(command)) return null
  if (/\bGIT_(?:DIR|WORK_TREE)\b/i.test(command)) return null
  return dir
}

/** The three forms that change the checkout they run in; null if allowed in `dir`, else the reason. */
function checkoutScopedReason(what, c, dir, cDirs, usesGitDirOpts) {
  if (usesGitDirOpts) return `git ${what} with --git-dir/--work-tree: the checkout it changes cannot be determined`
  let eff = dir
  for (const t of cDirs) eff = moveDir(eff, t)
  if (eff === null) return `git ${what}: the directory it runs in cannot be determined (a variable, a cd other than a leading \`cd DIR &&\`, env -C): use \`git -C <linked worktree>\``
  const kind = checkoutKind(eff)
  if (kind === 'linked') return null
  return `git ${what} in ${kind === 'main' ? 'the MAIN checkout' : 'a directory that is not a linked worktree'} (${eff}) changes its HEAD, index or worktrees: read-only agents work in a linked worktree (\`git worktree add --detach <path> <commit>\`, then \`git -C <path> …\`)`
}

/** Refusal reason for one effective git command, or null. @param {string|null} dir the directory the command starts in */
function gitReason(c, dir) {
  const { argv } = c
  let j = 1
  const cDirs = []
  let usesGitDirOpts = false
  for (; j < argv.length && argv[j].startsWith('-'); j++) {
    const t = argv[j]
    if (/^--(git-dir|work-tree)=/.test(t)) { usesGitDirOpts = true; continue }
    if (GIT_GLOBAL_OK.has(t)) continue
    if (GIT_GLOBAL_VALUED.has(t)) { if (t === '-C') cDirs.push(argv[j + 1]); else usesGitDirOpts = true; j++; continue }
    return `git ${t} is not a permitted global option for a read-only agent (-c / --exec-path / --config-env can run commands)`
  }
  const sub = argv[j]
  const args = argv.slice(j + 1)
  if (sub === undefined) return null
  const no = (why) => `git ${sub}: ${why} is not on the read-only git allow-list`
  if (GIT_FREE.has(sub)) {
    if (args.some((t) => /^--output(=|$)/.test(t))) return no('--output (writes a file)')
    if (sub === 'grep' && args.some((t) => /^(-O.*|--open-files-in-pager.*|--no-index|--untracked)$/.test(t))) return no('git grep -O/--no-index/--untracked (runs a pager or reads untracked/ignored files)')
    return null
  }
  switch (sub) {
    // A77d: history readers that were missing from the list. Every form that writes (stash push|pop|drop|clear, reflog expire|delete,
    // symbolic-ref with a value or -d/-m, --output) stays refused.
    case 'stash': return args[0] === 'list' && !args.some((t) => /^--output(=|$)/.test(t)) ? null : no('anything but `stash list`')
    case 'reflog': {
      if (args.some((t) => /^--output(=|$)/.test(t))) return no('--output (writes a file)')
      return args[0] === 'expire' || args[0] === 'delete' ? no(`\`reflog ${args[0]}\``) : null
    }
    case 'symbolic-ref': {
      const flags = args.filter((t) => t.startsWith('-'))
      const pos = args.filter((t) => !t.startsWith('-'))
      return flags.every((t) => ['-q', '--quiet', '--short', '--no-recurse'].includes(t)) && pos.length === 1 ? null : no('anything but `symbolic-ref [-q] [--short] <name>` (a second argument, -d and -m write)')
    }
    case 'verify-commit': return args.every((t) => ['-v', '--verbose', '--raw'].includes(t) || !t.startsWith('-')) ? null : no('that flag')
    case 'remote': return args.length === 0 || (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) ? null : no('anything but `remote` / `remote -v`')
    case 'branch': {
      const bad = onlyFlags(args, BRANCH_FLAGS, BRANCH_VALUED, { positionals: 'any' })
      if (bad) return no(bad)
      // a bare positional creates a branch; it is a pattern only together with --list/-l
      const positional = args.filter((t, k) => !t.startsWith('-') && !BRANCH_VALUED.has(args[k - 1]))
      return positional.length > 0 && !args.some((t) => t === '-l' || t === '--list') ? no('`branch <name>` (creates a branch)') : null
    }
    case 'tag': {
      const bad = onlyFlags(args, TAG_FLAGS, TAG_VALUED, { positionals: 'any' })
      if (bad) return no(bad)
      const positional = args.filter((t, k) => !t.startsWith('-') && !TAG_VALUED.has(args[k - 1]))
      return positional.length > 0 && !args.some((t) => t === '-l' || t === '--list') ? no('`tag <name>` (creates a tag)') : null
    }
    case 'config': {
      const rest = args.filter((t) => !CONFIG_SCOPE.has(t))
      return CONFIG_GET.has(rest[0]) && rest.length >= 2 && rest.slice(1).every((t) => !t.startsWith('-')) ? null : no('anything but `config --get[-all|-regexp] <key>`')
    }
    case 'fetch': {
      const refused = args.find((t) => FETCH_REFUSED.test(t))
      if (refused) return no(`${refused} (shallow / prune / forced fetches rewrite .git; use a plain \`git fetch origin <branch>\`)`)
      const bad = onlyFlags(args, FETCH_FLAGS, FETCH_VALUED, { positionals: 'any' })
      if (bad) return no(bad)
      const pos = args.filter((t, k) => !t.startsWith('-') && !FETCH_VALUED.has(args[k - 1]))
      // `git fetch origin a:b`, `git fetch a:b`, `+refs/…` write local refs; a scheme:// URL is a remote, not a refspec.
      return pos.some((t) => (t.includes(':') && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t)) || t.startsWith('+')) ? no('a refspec (writes local refs)') : null
    }
    case 'worktree': {
      const action = args[0]
      if (action === 'list') return args.slice(1).every((t) => ['--porcelain', '-v', '--verbose', '-z'].includes(t)) ? null : no('worktree list with that flag')
      if (action === 'remove') {
        if (!(args.slice(1).every((t) => t === '-f' || t === '--force' || !t.startsWith('-')) && args.length >= 2)) return no('worktree remove with that flag')
        // A77d H-11: a forced removal run from the main checkout can drop any worktree, locked or dirty ones included
        return args.some((t) => t === '-f' || t === '--force') ? checkoutScopedReason('worktree remove --force', c, dir, cDirs, usesGitDirOpts) : null
      }
      if (action === 'add') {
        const bad = onlyFlags(args.slice(1), WORKTREE_ADD_FLAGS, new Set(), { positionals: 'any' })
        if (bad) return no(`worktree add (${bad}; -b/-B would create a branch)`)
        // without --detach, `git worktree add <path>` creates a branch named after the path (A77c H-11)
        return args.includes('--detach') ? null : no('`worktree add` without --detach (it creates a branch)')
      }
      return no('worktree other than add|remove|list')
    }
    case 'checkout': {
      const flags = args.filter((t) => t.startsWith('-'))
      const pos = args.filter((t) => !t.startsWith('-'))
      if (!(args.includes('--detach') && flags.every((t) => t === '--detach' || t === '-q') && pos.length <= 1 && !pos.includes('.'))) return no('anything but `checkout --detach [<commit>]`')
      return checkoutScopedReason('checkout --detach', c, dir, cDirs, usesGitDirOpts) // A77d H-11: it detaches the HEAD of the checkout it runs in
    }
    case 'merge': {
      if (args.length === 1 && (args[0] === '--abort' || args[0] === '--quit')) return null
      const bad = onlyFlags(args, MERGE_FLAGS, new Set(), { positionals: 'any' })
      if (bad) return no(bad)
      if (!args.includes('--no-commit')) return no('`merge` without --no-commit (creates a commit)')
      if (!args.includes('--no-ff')) return no('`merge --no-commit` without --no-ff (a fast-forward moves the checked-out branch)')
      return checkoutScopedReason('merge', c, dir, cDirs, usesGitDirOpts) // A77d H-11: it changes the index and worktree of the checkout it runs in
    }
    default: return no(`\`${sub}\``)
  }
}

function ghReason(c) {
  return ghAllowReason(c.argv, { readonly: true })
}

/**
 * @param {string} command
 * @param {{cwd?: string}} [opts] cwd: the hook input's `cwd`. Without one, checkout/merge/worktree-remove-force are refused (fail closed).
 * @returns {string|null} a refusal reason, or null if a read-only agent may run it. Throws on unparseable input.
 */
export function decide(command, { cwd } = {}) {
  const { cmds, problems } = inspect(command)
  if (problems.length > 0) return problems[0]
  const dir = startDir(command, cmds, cwd)
  for (const c of cmds) {
    const why = c.base === 'git' ? gitReason(c, dir) : c.base === 'gh' ? ghReason(c) : null
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
    const why = decide(command, { cwd: input.cwd ?? process.env.CLAUDE_PROJECT_DIR })
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
