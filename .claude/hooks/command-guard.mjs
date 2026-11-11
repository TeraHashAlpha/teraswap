#!/usr/bin/env node
// PreToolUse hook (matcher: Bash) for EVERY agent: the semantic command guard (audit A77 H-1..H-3).
// `permissions.deny` patterns match command TEXT, so ordinary spellings (`git -C . push -uf`, `/usr/bin/ssh`,
// `env gh pr create`, `gh api repos/x -ftitle=y`, `FOO=1 git push --force`) slip past them. This hook tokenises the
// command (shell-parse.mjs) and decides on the parsed argv, then recurses into `sh -c`, `eval`, `xargs`, `npx X`...
// Protocol (https://code.claude.com/docs/en/hooks): tool-call JSON on stdin; exit 2 + stderr = block.
// Fails CLOSED: any parse/IO error exits 2, and settings.json wraps the call in `|| exit 2` + `onFailure: "block"`
// because the docs say any other exit code or a crash lets the tool call proceed.
// Not a sandbox: see "What this cannot stop" in docs/Runbooks/agent-harness.md. The permissions.deny patterns stay as
// a second layer.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { EXP, baseName, inspect } from './shell-parse.mjs'

// git global options that take a separate value.
export const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--attr-source'])
const GIT_FORBIDDEN_CONFIG = /^(alias\.|credential\.|core\.sshcommand(=|$)|remote\.[^=]*\.push=?)/i
const HISTORY_FILES = new Set(['.zsh_history', '.zhistory', '.bash_history', '.sh_history', '.history', '.histfile', 'fish_history', '.python_history', '.node_repl_history', '.zsh_sessions'])
const GH_PR_READ = new Set(['view', 'diff', 'checks', 'list', 'status'])
const PUSH_LONG_FORBIDDEN = ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '--prune']
const PUSH_VALUED = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack'])
const GREP_VALUED = new Set(['-A', '-B', '-C', '-m', '-d', '-D', '-g', '-t', '-T', '-j', '-M', '--include', '--exclude', '--exclude-dir', '--color', '--max-count', '--context', '--after-context', '--before-context', '--glob', '--type', '--type-not', '--max-depth', '--file', '-f'])

/** git: skip global options; returns the subcommand, its args, and the `-c key=value` configs seen. */
export function gitParts(argv) {
  const configs = []
  let j = 1
  while (j < argv.length && argv[j].startsWith('-') && argv[j] !== '--') {
    if (argv[j] === '-c' && argv[j + 1] !== undefined) configs.push(argv[j + 1])
    if (argv[j].startsWith('--config-env=')) configs.push(argv[j].slice(13))
    j += GIT_VALUE_OPTS.has(argv[j]) ? 2 : 1
  }
  return { sub: argv[j], args: argv.slice(j + 1), configs }
}

/** gh: first two positionals (global -R/--repo value skipped); `afterGroup` = every token after the first positional. */
export function ghParts(argv) {
  const parts = []
  let groupAt = -1
  for (let k = 1; k < argv.length && parts.length < 2; k++) {
    const t = argv[k]
    if (t === '-R' || t === '--repo' || t === '--hostname') { k++; continue }
    if (t.startsWith('-')) continue
    if (parts.length === 0) groupAt = k
    parts.push(t)
  }
  return { group: parts[0], action: parts[1], afterGroup: groupAt < 0 ? [] : argv.slice(groupAt + 1) }
}

/** `gh api` is allowed only when provably a GET. @param {string[]} args tokens after `api` @returns {string|null} reason */
export function ghApiWriteReason(args) {
  const SHORT_VALUED = new Set(['H', 'q', 't', 'p', 'X', 'f', 'F'])
  const LONG_VALUED = new Set(['--header', '--jq', '--template', '--preview', '--hostname', '--cache'])
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq < 0 ? t : t.slice(0, eq)
      if (name === '--method') {
        const v = eq >= 0 ? t.slice(eq + 1) : args[++i]
        if (String(v).toUpperCase() !== 'GET') return `gh api --method ${v}`
      } else if (name === '--field' || name === '--raw-field' || name === '--input') {
        return `gh api ${name}`
      } else if (LONG_VALUED.has(name) && eq < 0) i++
      continue
    }
    if (t.length > 1 && t[0] === '-') {
      for (let k = 1; k < t.length; k++) {
        const ch = t[k]
        if (ch === 'f' || ch === 'F') return `gh api -${ch}`
        if (ch === 'X') {
          const attached = t.slice(k + 1).replace(/^=/, '')
          const v = attached !== '' ? attached : args[++i]
          if (String(v).toUpperCase() !== 'GET') return `gh api -X ${v}`
          break
        }
        if (SHORT_VALUED.has(ch)) { if (k === t.length - 1) i++; break }
      }
    }
  }
  return null
}

// Interpreters take their program as an argument ("node -e ….env…"): look for a secrets-file name INSIDE the text.
// `process.env.HOME`, `os.environ` and `import.meta.env` do not match: the dot must follow a non-word character.
const INTERPRETERS = /^(node|nodejs|deno|bun|python[0-9.]*|perl|ruby|php|lua|osascript|awk|gawk|mawk)$/
const ENV_IN_TEXT = /(?:^|[^A-Za-z0-9_-])(\.env(?:\.[A-Za-z0-9_.-]*)?)(?![A-Za-z0-9_-])/g
const HISTORY_IN_TEXT = /(?:^|[^A-Za-z0-9_-])(\.(?:zsh_history|zhistory|bash_history|sh_history|histfile|python_history|node_repl_history))(?![A-Za-z0-9_-])/g
function embeddedSecretReason(word) {
  for (const m of word.matchAll(ENV_IN_TEXT)) if (m[1].toLowerCase() !== '.env.example') return `${m[1]} named inside an interpreter program`
  for (const m of word.matchAll(HISTORY_IN_TEXT)) return `${m[1]} named inside an interpreter program`
  return null
}

function envPathReason(word) {
  const w = word.replace(/^\d*[<>]+&?/, '')
  const cands = [w]
  const eq = w.indexOf('=')
  if (eq >= 0) cands.push(w.slice(eq + 1))
  for (const c of cands) {
    const b = baseName(c)
    if (/^\.env(\..+)?$/.test(b) && b !== '.env.example') return `${b} is an environment-secrets file`
    if (b.startsWith('.') && /[*?[]/.test(b)) { // a glob only matches dotfiles when its first character is a literal dot
      const re = new RegExp(`^${b.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
      if (['.env', '.env.local', '.env.production', '.env.development', '.env.test'].some((n) => re.test(n))) return `${b} would match an environment-secrets file`
    }
    if (HISTORY_FILES.has(b)) return `${b} is a shell-history file`
  }
  return null
}

/** Words that are DATA (a commit message, a grep pattern), so quoting a name there is not an access. */
function dataWords(c) {
  const out = []
  const { argv, base } = c
  if (base === 'git') {
    const { sub, args } = gitParts(argv)
    if (['commit', 'tag', 'merge', 'notes', 'stash', 'revert'].includes(sub)) {
      args.forEach((t, k) => {
        if (/^-[A-Za-z]*m/.test(t) && !t.startsWith('--')) { out.push(t); if (t.endsWith('m') && args[k + 1] !== undefined) out.push(args[k + 1]) } // -m MSG, -am MSG, -mMSG
        else if (t === '--message' && args[k + 1] !== undefined) out.push(args[k + 1])
        else if (t.startsWith('--message=')) out.push(t)
      })
    }
    if (sub === 'log' || sub === 'rev-list' || sub === 'shortlog') {
      args.forEach((t, k) => { if (['--grep', '-S', '-G', '--author', '--committer'].includes(t) && args[k + 1] !== undefined) out.push(args[k + 1]); else if (/^(--grep=|--author=|--committer=|-S.|-G.)/.test(t)) out.push(t) })
    }
    if (sub === 'grep') out.push(...grepPattern(args, 0))
  } else if (GREP_FAMILY.has(base)) {
    out.push(...grepPattern(argv, 1))
  }
  return out
}

function grepPattern(tokens, from) {
  const out = []
  let usedE = false
  let firstPositional = null
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k]
    if (t === '-e' || t === '--regexp') { usedE = true; if (tokens[k + 1] !== undefined) out.push(tokens[++k]); continue }
    if (t.startsWith('--regexp=') || (t.startsWith('-e') && t.length > 2 && !t.startsWith('--'))) { usedE = true; out.push(t); continue }
    if (t.startsWith('-')) { if (GREP_VALUED.has(t)) k++; continue }
    if (firstPositional === null) firstPositional = t
  }
  if (!usedE && firstPositional !== null) out.push(firstPositional)
  return out
}

function gitPushReason(args) {
  for (let k = 0; k < args.length; k++) {
    const t = args[k]
    if (t.startsWith(EXP) || t.includes(`:${EXP}`)) return 'git push with an argument built from an expansion cannot be inspected for --force / +refspec / :delete (write the branch literally)'
    if (t.startsWith('--')) {
      const opt = t.split('=')[0]
      if (opt.length >= 4 && PUSH_LONG_FORBIDDEN.some((f) => f.startsWith(opt))) return `git push ${opt} (force / mirror / remote delete)`
      if (PUSH_VALUED.has(opt) && !t.includes('=')) k++
      continue
    }
    if (t.length > 1 && t[0] === '-') {
      for (const ch of t.slice(1)) {
        if (ch === 'f') return 'git push -f (force)'
        if (ch === 'd') return 'git push -d (remote delete)'
        if (ch === 'o') { if (t.endsWith('o')) k++; break }
      }
      continue
    }
    if (t.startsWith('+') || t.includes(':+')) return `git push refspec "${t}" forces`
    if (t.startsWith(':')) return `git push refspec "${t}" deletes a remote ref`
  }
  return null
}

function gitReason(c) {
  const { sub, args, configs } = gitParts(c.argv)
  for (const cfg of configs) if (GIT_FORBIDDEN_CONFIG.test(cfg)) return `git -c ${cfg.split('=')[0]} (alias / credential / ssh / push override)`
  if (sub === undefined) return null
  if (sub.startsWith('credential')) return 'git credential* (CLAUDE.md "Do NOT" #13)'
  if (sub === 'push' || sub === 'send-pack' || sub === 'http-push') return gitPushReason(args)
  return null
}

function ghReason(c) {
  const { group, action, afterGroup } = ghParts(c.argv)
  if (group === 'pr' && action !== undefined && !GH_PR_READ.has(action)) return `gh pr ${action} (only view, diff, checks, list, status are allowed; PR creation/merge is the owner's)`
  if (group === 'alias') return 'gh alias (an alias can hide a refused command)'
  if (group === 'codespace' || group === 'cs') return 'gh codespace (ssh into a remote machine)'
  if (group === 'api') {
    const why = ghApiWriteReason(afterGroup)
    if (why) return `${why} — gh api is allowed only as a provable GET`
  }
  return null
}

function rsyncReason(argv) {
  for (let k = 1; k < argv.length; k++) {
    const t = argv[k]
    if (t === '--rsh' || t.startsWith('--rsh=') || (t.startsWith('-') && !t.startsWith('--') && t.includes('e'))) return 'rsync -e/--rsh (runs ssh)'
    if (t.startsWith('-')) continue
    if (/^(rsync|ssh):\/\//.test(t) || /^[^/]*:/.test(t)) return `rsync to/from a remote (${t.split(':')[0]}:…)`
  }
  return null
}

/** Reason to refuse one effective command, or null. */
export function commandReason(c) {
  const { argv, base } = c

  // Quoted data (commit message, grep pattern) is not an access; everything else is checked.
  const rest = c.words.slice()
  for (const v of dataWords(c)) {
    const k = rest.indexOf(v)
    if (k >= 0) rest.splice(k, 1)
  }
  for (const w of rest) {
    const why = envPathReason(w)
    if (why) return why
  }
  if (INTERPRETERS.test(base)) {
    for (const w of rest.slice(1)) {
      const why = embeddedSecretReason(w)
      if (why) return why
    }
  }

  switch (base) {
    case 'ssh': case 'scp': case 'sftp': case 'ssh-add': return `${base} (remote shell / key agent; CLAUDE.md "Do NOT" #15)`
    case 'pm2': return 'pm2 (production process manager)'
    case 'security': return 'security (macOS keychain; CLAUDE.md "Do NOT" #13)'
    case 'history': case 'fc': return `${base} (shell history)`
    case 'rsync': return rsyncReason(argv)
    case 'cast': {
      const hit = argv.slice(1).find((t) => ['send', 's', 'publish'].includes(t) || /^eth_send/i.test(t))
      return hit ? `cast ${hit} (broadcasts a transaction)` : null
    }
    case 'forge':
      return argv.slice(1).some((t) => t === '--broadcast' || t.startsWith('--broadcast=') || t === '--resume') ? 'forge --broadcast / --resume (sends transactions)' : null
    case 'git': return gitReason(c)
    case 'gh': return ghReason(c)
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      const at = argv.indexOf('audit')
      if (at >= 0 && argv.slice(at + 1).some((t) => t === 'fix' || t.startsWith('--fix'))) return 'npm audit fix (rewrites the lockfile; owner decision)'
      return null
    }
    default: return null
  }
}

/** @returns {string|null} a refusal reason, or null if the command may run. Throws on unparseable input. */
export function decide(command) {
  const { cmds, problems } = inspect(command)
  if (problems.length > 0) return problems[0]
  for (const c of cmds) {
    const why = commandReason(c)
    if (why) return why
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
      process.stderr.write(`command-guard: refused — ${why}. Report the manual step to the owner instead. See docs/Runbooks/agent-harness.md.\n`)
      process.exit(2)
    }
  } catch (e) {
    process.stderr.write(`command-guard: failing closed (${e.message})\n`)
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
