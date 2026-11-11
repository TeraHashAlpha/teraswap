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
const GIT_FORBIDDEN_CONFIG = /^(alias\.|credential\.|core\.sshcommand(=|$)|remote\.[^=]*\.(push|mirror|pushurl)=?)/i
const HISTORY_NAMES = ['.zsh_history', '.zhistory', '.bash_history', '.sh_history', '.history', '.histfile', 'fish_history', '.python_history', '.node_repl_history', '.zsh_sessions']
const HISTORY_FILES = new Set(HISTORY_NAMES)
const HISTORY_DIRS = new Set(['.zsh_sessions'])
const ENV_NAMES = ['.env', '.env.local', '.env.production', '.env.development', '.env.test']
const PUSH_LONG_FORBIDDEN = ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '--prune']
const PUSH_VALUED = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack'])
const GREP_VALUED = new Set(['-A', '-B', '-C', '-m', '-d', '-D', '-g', '-t', '-T', '-j', '-M', '--include', '--exclude', '--exclude-dir', '--max-count', '--context', '--after-context', '--before-context', '--glob', '--type', '--type-not', '--max-depth', '--file', '-f'])

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

/** `gh api` is allowed only when provably a GET. @param {string[]} args tokens after `api` @returns {string|null} reason */
export function ghApiWriteReason(args) {
  const SHORT_VALUED = new Set(['H', 'q', 't', 'p', 'X', 'f', 'F'])
  const LONG_VALUED = new Set(['--header', '--jq', '--template', '--preview', '--hostname', '--cache'])
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    if (/method-override/i.test(t)) return 'gh api with a method-override header'
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

/** `a{b,c}d` -> [abd, acd]; bounded, one group at a time. */
function expandBraces(w, out = [], budget = { n: 64 }) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(w)
  if (!m || budget.n <= 0) { out.push(w); return out }
  for (const alt of m[1].split(',')) { budget.n--; expandBraces(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length), out, budget) }
  return out
}

/** @param {{nameOnly?: boolean}} [opts] nameOnly: the command only tests or lists names (test, [, ls): `.env*` is not a read */
function envPathReason(word, { nameOnly = false } = {}) {
  const w0 = word.replace(/^\d*[<>]+&?/, '')
  const cands = []
  for (const x of expandBraces(w0)) {
    cands.push(x)
    const eq = x.indexOf('=')
    if (eq >= 0) cands.push(x.slice(eq + 1))
  }
  for (const c of cands) {
    const b = baseName(c)
    if (!nameOnly && /^\.env(\..+)?$/.test(b) && b !== '.env.example') return `${b} is an environment-secrets file`
    if (c.split('/').some((seg) => HISTORY_DIRS.has(seg.toLowerCase()))) return `${c} is inside the shell-history directory`
    if (/[*?[]/.test(b)) { // a glob only matches dotfiles when its first character is a literal dot
      let re = null
      try { re = new RegExp(`^${b.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`) } catch { /* `[`, `[[`, `]]`: the test command's own words, not a glob */ }
      const names = [...(nameOnly ? [] : ENV_NAMES), ...HISTORY_NAMES]
      const hit = re && names.find((n) => (n.startsWith('.') ? b.startsWith('.') : /fish/i.test(c)) && re.test(n))
      if (hit) return `${b} would match ${hit}`
    }
    if (HISTORY_FILES.has(b)) return `${b} is a shell-history file`
  }
  return null
}

// Commands that only test or list NAMES: `test -f .env.local`, `[ -e .env ]`, `ls .env*` do not read the file (A77b lows).
const NAME_ONLY = new Set(['test', '[', '[[', 'ls'])

// ---------------------------------------------------------------------------------------------------------------
// Self-protection (A77b M-10): the harness must not be rewritten through Bash. Edit/Write on these paths are `ask`
// rules in settings.json; this covers a Bash word or redirect target.
const PROTECTED_RE = /(?:^|[/=:])\.claude\/(?:settings[^/]*\.json|hooks(?:\/|$))/i
const PROTECTED_DIR_NAMES = ['settings.json', 'settings.local.json', 'hooks']
const WRITER_BASES = new Set(['tee', 'rm', 'mv', 'cp', 'truncate', 'chmod', 'chown', 'ln', 'install', 'dd', 'touch', 'unlink', 'shred', 'rsync', 'patch', 'sponge', 'ed', 'ex', 'vi', 'vim', 'nano', 'ditto'])
const GIT_TREE_WRITERS = new Set(['checkout', 'restore', 'rm', 'mv', 'apply', 'clean', 'reset', 'am', 'stash', 'switch', 'cherry-pick', 'revert', 'merge', 'rebase', 'pull'])

function inPlaceFlag(argv) {
  return argv.slice(1).some((t) => t === '--in-place' || t.startsWith('--in-place=') || (/^-[a-zA-Z]+$/.test(t) && /i/.test(t)) || /^-i/.test(t))
}
function canWrite(c) {
  const { base, argv } = c
  if (WRITER_BASES.has(base)) return true
  if ((base === 'sed' || base === 'gsed' || base === 'perl' || base === 'ruby') && inPlaceFlag(argv)) return true
  if (base === 'git') return GIT_TREE_WRITERS.has(gitParts(argv).sub)
  return false
}
function protectedWord(w, inClaudeDir, inHooksDir) {
  for (const x of expandBraces(w.replace(/^\d*>{1,2}[|&]?/, ''))) {
    if (PROTECTED_RE.test(x)) return true
    // a glob on the directory segment: .claude/set*, .claude/h*, .claude/*, or the directory itself
    const m = /(?:^|[/=:])\.claude(?:\/([^/]*))?\/?$/.exec(x)
    if (m) {
      if (m[1] === undefined || m[1] === '') return true // `.claude` itself: rm -rf .claude
      if (/[*?[]/.test(m[1])) {
        const re = new RegExp(`^${m[1].replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
        if (PROTECTED_DIR_NAMES.some((n) => re.test(n))) return true
      }
    }
    if (inHooksDir && !x.includes('/') && x !== '') return true // `cd .claude/hooks && echo x > command-guard.mjs`
    if (inClaudeDir && !x.includes('/') && (PROTECTED_DIR_NAMES.includes(x.toLowerCase()) || /^settings[^/]*\.json$/i.test(x))) return true
  }
  return false
}
/** Redirect targets that WRITE (> >> >| &> &>>), from the operator/target words of one simple command. */
function writeTargets(redirs) {
  const out = []
  for (let i = 0; i < redirs.length; i++) {
    const w = redirs[i]
    let m = /^[\d&]*>{1,2}\|?$/.exec(w)
    if (m) { if (redirs[i + 1] !== undefined) out.push(redirs[++i]); continue }
    m = /^[\d&]*>{1,2}\|?(?!&)(.+)$/.exec(w)
    if (m && !/^&/.test(m[1])) out.push(m[1])
  }
  return out
}
function selfProtectionReason(c, ctx) {
  const targets = c.redirOnly ? writeTargets(c.words) : []
  for (const t of targets) if (protectedWord(t, ctx.inClaudeDir, ctx.inHooksDir)) return `a redirect writes ${t}: the harness (.claude/settings*.json, .claude/hooks/) is changed by the owner, not through Bash`
  if (!c.redirOnly && canWrite(c)) {
    for (const w of c.words) if (protectedWord(w, ctx.inClaudeDir, ctx.inHooksDir)) return `${c.base} could write or delete ${w}: the harness (.claude/settings*.json, .claude/hooks/) is changed by the owner, not through Bash`
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
      if (opt.length >= 3 && PUSH_LONG_FORBIDDEN.some((f) => f.startsWith(opt))) return `git push ${opt} (force / mirror / remote delete)`
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
  if (sub === 'config' && args.some((t) => GIT_FORBIDDEN_CONFIG.test(t.replace(/^--?[a-z-]+=?/i, '')) || GIT_FORBIDDEN_CONFIG.test(t))) return 'git config of an alias / credential / ssh / push-mirror key'
  if (sub === 'push' || sub === 'send-pack' || sub === 'http-push') return gitPushReason(args)
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Allow-lists (audit A77b H-6, H-7, M-6, M-9): the riskiest tools are not matched against a list of bad spellings; only
// the listed forms run and everything else is refused. Over-refusing a rare legitimate command is accepted (the runbook
// says how the owner runs it); under-refusing is not.

/** gh: group -> actions. `api` is separate (provable GET only). */
export const GH_ALLOWED = { pr: ['view', 'diff', 'checks', 'list', 'status', 'checkout'], run: ['view', 'list'], repo: ['view'], issue: ['view', 'list'] }
const GH_BARE = new Set(['--version', '--help', '-h'])

/**
 * @param {string[]} argv
 * @param {{readonly?: boolean}} [opts] readonly: also drop `pr checkout` (it writes a local branch)
 * @returns {string|null}
 */
export function ghAllowReason(argv, { readonly = false } = {}) {
  if (argv.length === 1) return null // `gh` prints help
  let k = 1
  // The one global flag allowed BEFORE the command is -R/--repo. Any other flag before the action is refused, because
  // cobra takes the next word as that flag's value: `gh pr -t view merge 5` is `gh pr merge 5` (A77b M-6).
  if (argv[k] === '-R' || argv[k] === '--repo') k += 2
  else if (/^(-R.+|--repo=.+)$/.test(argv[k])) k += 1
  const group = argv[k]
  if (group === undefined) return null
  if (k === 1 && argv.length === 2 && GH_BARE.has(group)) return null
  if (group.startsWith('-')) return `gh ${group} before the command (only -R/--repo may precede it)`
  if (group === 'api') {
    const why = ghApiWriteReason(argv.slice(k + 1))
    return why ? `${why} — gh api is allowed only as a provable GET` : null
  }
  const actions = GH_ALLOWED[group]
  const action = argv[k + 1]
  if (!actions) return `gh ${group} is not on the gh allow-list (pr view|diff|checks|list|status|checkout, run view|list, repo view, issue view|list, api GET)`
  if (action === undefined || action.startsWith('-')) return `gh ${group} ${action ?? ''}: the action must directly follow the command (no flag in between)`.replace('  ', ' ')
  if (!actions.includes(action) || (readonly && group === 'pr' && action === 'checkout')) return `gh ${group} ${action} is not on the ${readonly ? 'read-only ' : ''}gh allow-list`
  return null
}

/** cast: read subcommands only. The subcommand must be argv[1] (a flag before it cannot hide `send`). */
const CAST_EXACT = new Set(['call', 'balance', 'block', 'block-number', 'tx', 'receipt', 'code', 'storage', 'chain-id', 'gas-price', 'nonce', 'logs', 'estimate', 'sig', 'keccak'])
const CAST_PREFIX = ['4byte', 'abi-', 'calldata', 'to-', 'from-']
const CAST_BARE = new Set(['--help', '-h', '--version', '-V'])
/** `cast send --help`, `cast wallet new -h`: up to three plain words and then a help flag, nothing else. */
function helpOnly(argv) {
  const rest = argv.slice(1)
  if (rest.length < 2 || rest.length > 4) return false
  const last = rest[rest.length - 1]
  return (last === '--help' || last === '-h') && rest.slice(0, -1).every((t) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(t))
}
export function castAllowReason(argv) {
  if (argv.length === 1) return null
  const sub = argv[1]
  if (argv.length === 2 && CAST_BARE.has(sub)) return null
  if (helpOnly(argv)) return null
  if (CAST_EXACT.has(sub) || CAST_PREFIX.some((p) => sub.startsWith(p))) return null
  return `cast ${sub} is not on the cast allow-list (read subcommands only: call balance block block-number tx receipt code storage chain-id gas-price nonce logs estimate sig 4byte* abi-* calldata* keccak to-* from-*)`
}

export function forgeReason(argv) {
  const rest = argv.slice(1)
  if (rest.some((t) => t === '--broadcast' || t.startsWith('--broadcast=') || t === '--resume')) return 'forge --broadcast / --resume (sends transactions)'
  if (rest.includes('create')) return 'forge create (deploys a contract)'
  const first = rest.find((t) => !t.startsWith('-'))
  if (first === 'c') return 'forge c (alias of create)'
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

/** Reason to refuse one effective command, or null. @param {{inClaudeDir?: boolean, inHooksDir?: boolean}} [ctx] */
export function commandReason(c, ctx = {}) {
  const { argv, base } = c

  // Redirect targets: checked on EVERY simple command, before anything else can return (A77b H-5). They are files, not data.
  if (c.redirOnly) {
    for (const w of c.words) {
      const why = envPathReason(w)
      if (why) return why
    }
    return selfProtectionReason(c, ctx)
  }

  // Quoted data (commit message, grep pattern) is not an access; everything else is checked.
  const rest = c.words.slice()
  for (const v of dataWords(c)) {
    const k = rest.indexOf(v)
    if (k >= 0) rest.splice(k, 1)
  }
  const nameOnly = NAME_ONLY.has(base)
  for (const w of rest) {
    const why = envPathReason(w, { nameOnly })
    if (why) return why
  }
  if (INTERPRETERS.test(base)) {
    for (const w of rest.slice(1)) {
      const why = embeddedSecretReason(w)
      if (why) return why
    }
  }
  const own = selfProtectionReason(c, ctx)
  if (own) return own

  if (base.startsWith('git-credential')) return `${base} (git credential helper; CLAUDE.md "Do NOT" #13)`
  switch (base) {
    case 'ssh': case 'scp': case 'sftp': case 'ssh-add': case 'ssh-copy-id': return `${base} (remote shell / key agent; CLAUDE.md "Do NOT" #15)`
    case 'pm2': return 'pm2 (production process manager)'
    case 'security': return 'security (macOS keychain; CLAUDE.md "Do NOT" #13)'
    case 'history': case 'fc': return `${base} (shell history)`
    case 'rsync': return rsyncReason(argv)
    case 'cast': return castAllowReason(argv)
    case 'forge': return forgeReason(argv)
    case 'git': return gitReason(c)
    case 'gh': return ghAllowReason(argv)
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
  // $HISTFILE names the history file without spelling it; the parser would turn it into an unknown expansion.
  if (/\$\{?!?HISTFILE\b/.test(command)) return '$HISTFILE is the shell-history file'
  const { cmds, problems } = inspect(command)
  if (problems.length > 0) return problems[0]
  // `cd .claude && rm settings.json`: relative names count once the command line has moved into .claude
  const inClaudeDir = cmds.some((c) => ['cd', 'pushd'].includes(c.base) && c.words.some((w) => /(?:^|\/)\.claude(?:\/|$)/i.test(w)))
  const inHooksDir = cmds.some((c) => ['cd', 'pushd'].includes(c.base) && c.words.some((w) => /(?:^|\/)\.claude\/hooks(?:\/|$)/i.test(w)))
  for (const c of cmds) {
    const why = commandReason(c, { inClaudeDir, inHooksDir })
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
