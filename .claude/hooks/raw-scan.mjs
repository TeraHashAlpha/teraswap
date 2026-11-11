// Layer 0 of the Bash guard (audit A77c H-8, H-9, H-10): a raw-text scan that does NOT parse the shell.
// A hand-written shell parser keeps having gaps (here-strings, attached redirects, `cd` + relative paths), so this runs
// FIRST, on the whole command string, with quotes and backslashes removed and whitespace collapsed. There is no
// tokenising: it looks for forbidden NAMES anywhere in the text, so it does not matter how the shell would have split,
// quoted, nested or redirected them. It over-refuses on purpose (a `grep` pattern that names `.env` is refused).
// ONE exemption: a lone `git commit` (optionally after `git add … &&`) whose message holds no `$`, backtick or `<`
// (outside a `<<'EOF'` body) may mention these words: the message literals are removed and the rest of the command is
// still scanned.
// A77d: three rules look at ONE region of the text instead of all of it, because a flag of another tool is not a flag of
// `gh` or `git push` (`gh pr diff 5 | grep -F x`, `git stash push -m "a + b"`, `git fetch --prune && git push origin x`);
// each falls back to the whole text when the region holds an expansion or the command uses xargs/parallel, since then
// text from elsewhere can reach that argv.
// Layer 1 (shell-parse.mjs + command-guard.mjs) decides on parsed argv; layer 2 is the permissions.deny patterns.
// Not a sandbox: see "What this cannot stop" in docs/Runbooks/agent-harness.md.

/** Lower-cases, removes quotes and backslashes, collapses whitespace, `//` -> `/` and `/./` -> `/`. */
export function normalise(command) {
  let t = String(command).toLowerCase().replace(/['"\\]/g, '').replace(/\s+/g, ' ')
  t = t.replace(/\/{2,}/g, '/')
  while (t.includes('/./')) t = t.replaceAll('/./', '/')
  return t.trim()
}

/**
 * Splits `src` at unquoted separator characters (`seps`, a string of characters from `| & ; \n`); quote-aware but nothing
 * more, so an unbalanced quote just makes the rest one region (the conservative direction). An `&` inside `>&`, `<&`
 * or `&>` is a redirection, not a separator. Each piece is returned normalised.
 */
export function splitRegions(src, seps) {
  const s = String(src)
  const out = []
  let cur = ''
  let q = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && q !== "'") { cur += c + (s[i + 1] ?? ''); i++; continue }
    if (q) { if (c === q) q = ''; cur += c; continue }
    if (c === "'" || c === '"') { q = c; cur += c; continue }
    if (seps.includes(c) && !(c === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>'))) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map(normalise).filter((x) => x !== '')
}
const FEEDS_ARGV = /(?<![a-z0-9_-])g?(?:xargs|parallel)(?![a-z0-9_-])/
/** True when text from OUTSIDE a region can end up in its argv (an expansion in it, or xargs/parallel anywhere): scan the whole command. */
const reachesFromOutside = (region, whole) => /[$`]/.test(region) || FEEDS_ARGV.test(whole)

const wordRe = (w) => new RegExp(`(?<![a-z0-9_-])${w}(?![a-z0-9_-])`)
const has = (t, w) => wordRe(w).test(t)
const firstWord = (t, words) => words.find((w) => has(t, w)) ?? null

// ---------------------------------------------------------------------------------------------------------------
// The one exemption.

/** Index just after the `)` that closes a `$(cat <<'EOF' ... EOF )` starting at s[j], or -1. */
function heredocSubstitutionEnd(s, j) {
  const head = /\$\(\s*cat\s+<<(-?)\s*'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\n/y
  head.lastIndex = j
  const m = head.exec(s)
  if (!m) return -1
  const strip = m[1] === '-'
  let p = head.lastIndex
  for (;;) {
    if (p >= s.length) return -1
    let e = s.indexOf('\n', p)
    if (e < 0) e = s.length
    const line = s.slice(p, e)
    p = Math.min(e + 1, s.length)
    if ((strip ? line.replace(/^\t+/, '') : line) === m[2]) break
  }
  const close = /\s*\)/y
  close.lastIndex = p
  return close.test(s) ? close.lastIndex : -1
}

/**
 * A lone `git commit` (flags + message literals only): the command with every quoted literal replaced by an empty one,
 * or null when it is anything else. Refuses (null) on any `$`, backtick or `<` inside a message other than the
 * `$(cat <<'EOF' ... EOF)` wrapper, and on any shell operator, comment or substitution outside the quotes.
 */
export function loneCommitRemainder(command) {
  const whole = String(command)
  // A77d: `git add -A && git commit …` is the everyday pair. The add part is plain words only (no quote, `$`, backtick,
  // operator) and stays in the returned remainder, so `git add .env` and `git add .claude/hooks/x` are still scanned.
  const add = /^\s*git\s+add(?:\s+[^\s;&|<>()$`'"\\{}#]+)*\s*&&\s*(?=git\s+commit(?:\s|$))/.exec(whole)
  const prefix = add ? add[0] : ''
  const s = whole.slice(prefix.length)
  if (!/^\s*git\s+commit(?:\s|$)/.test(s)) return null
  const n = s.length
  let out = prefix
  let i = 0
  while (i < n) {
    const c = s[i]
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0 || /[$`<]/.test(s.slice(i + 1, j))) return null
      out += "''"
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      let closed = false
      while (j < n) {
        const d = s[j]
        if (d === '\\') { j += 2; continue }
        if (d === '"') { closed = true; break }
        if (d === '$' && s[j + 1] === '(') {
          const end = heredocSubstitutionEnd(s, j)
          if (end < 0) return null
          j = end
          continue
        }
        if (d === '$' || d === '`' || d === '<') return null
        j++
      }
      if (!closed) return null
      out += '""'
      i = j + 1
    } else if (/[;&|<>()`$\n\r{}#]/.test(c)) {
      return null
    } else {
      out += c
      i++
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// "Pure reader" (for the harness-path rule only): readers joined by pipes, nothing that writes, redirects or substitutes.
// A77d: `git -C DIR`, `git blame`, `git ls-files`, `jq`, and a leading `cd DIR &&` are reads too.
const CD_WORD = String.raw`[^\s;&|<>()$` + '`' + String.raw`\\'"]+`
const GIT_C = String.raw`-C +` + CD_WORD
const READERS = new RegExp(String.raw`^(?:cat|head|tail|grep|rg|wc|ls|stat|diff|jq|git(?: +(?:--no-pager|-p|${GIT_C}))* +(?:diff|log|show|blame|ls-files))(?= |$)`)
const LEADING_CD = new RegExp(String.raw`^\s*(?:cd +${CD_WORD} *&& *)+`)
export function isPureReader(command) {
  const s = String(command)
  if (/[$`\n\r\\]/.test(s)) return false
  if (/(?:^|[\s;&|])(?:cd|-C) +[^\s;&|]*\.claude/i.test(s)) return false // a cd / -C INTO the harness stays a layer-0 refusal
  const body = s.replace(LEADING_CD, '')
  const outside = body.replace(/'[^']*'|"[^"]*"/g, '""')
  if (/[<>;&(){}]/.test(outside)) return false
  if (/--output|--pre(?:=|\s|$)|--open-files-in-pager/.test(body)) return false
  return outside.split('|').every((p) => READERS.test(p.trim()))
}

// ---------------------------------------------------------------------------------------------------------------
// Glob helpers (a glob that COULD match a protected name is a mention of it).
function expandBraces(w, out = [], budget = { n: 32 }) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(w)
  if (!m || budget.n <= 0) { out.push(w); return out }
  for (const alt of m[1].split(',')) { budget.n--; expandBraces(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length), out, budget) }
  return out
}
function globRe(g) {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const j = g.indexOf(']', i + 2)
      if (j < 0) re += '\\['
      else { re += `[${g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = j }
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  try { return new RegExp(`^${re}$`) } catch { return /^/ } // an unreadable glob counts as a match: fail closed
}
export const globMatchesAny = (glob, names) => expandBraces(glob).some((g) => { const re = globRe(g); return names.some((n) => re.test(n)) })

const SECRET_DOT_NAMES = ['.claude', '.env', '.env.local', '.env.production', '.env.development', '.env.test', '.zsh_history', '.zhistory', '.bash_history', '.sh_history', '.history', '.histfile', '.python_history', '.node_repl_history', '.zsh_sessions']
const CLAUDE_CHILDREN = ['settings.json', 'settings.local.json', 'hooks']

/** `.cl*`, `.c?aude`, `.e*`, `.z*history`: a dotted glob with a literal start that could match a protected name. */
function dotGlob(t) {
  for (const m of t.matchAll(/(?<![a-z0-9_.-])(\.[^ /;&|<>()]*)/g)) {
    const chunk = m[1]
    if (!/[*?[{]/.test(chunk) || /^\.[*?]/.test(chunk)) continue
    if (globMatchesAny(chunk, SECRET_DOT_NAMES)) return chunk
  }
  return null
}
/** `.claude/set*`, `.claude/h*`, `.claude/*`, `.claude/`: the protected children by glob, or the directory itself. */
function claudeChildGlob(t) {
  for (const m of t.matchAll(/\.claude\/([^ /;&|<>()]*)/g)) {
    const chunk = m[1]
    if (chunk === '') return '.claude/'
    if (/[*?[{]/.test(chunk) && globMatchesAny(chunk, CLAUDE_CHILDREN)) return `.claude/${chunk}`
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Rules. Each returns the matched text (for the refusal message) or null.
const ENV_RE = /(?<=^|[^a-z0-9_-]|(?:^|\s)-[a-z0-9]+)\.env(?![a-z0-9_-])/g
function envRule(t) {
  // `.env` as a name: after a separator, or glued to a short flag (`base64 -i.env`, `grep -f.env`). `process.env.HOME`,
  // `os.environ`, `import.meta.env` and `src/env.ts` are not file names and pass; `.env.example` and `.env*.example` pass.
  for (const m of t.matchAll(ENV_RE)) {
    const rest = t.slice(m.index + 4)
    const suffix = /^\.[a-z0-9_.-]*/.exec(rest)?.[0] ?? ''
    if (/\.example$/.test(suffix)) continue // `.env.example`, `.env.executor.example`: tracked templates (A77d)
    return t.slice(m.index, m.index + 4 + suffix.length)
  }
  return null
}

function harnessRule(t, { pure }) {
  if (pure) return null
  const direct = /\.claude\/(?:settings|hooks)/.exec(t)
  if (direct) return direct[0]
  const dirOpt = /(?:^|[ ;&|(])(?:(?:cd|pushd)(?: +-[a-z]+)*|-c|--work-tree|--git-dir|--prefix|--chdir|--directory)[ =]+[^ ;&|]*\.claude(?![a-z0-9_-])/.exec(t)
  if (dirOpt) return dirOpt[0].trim()
  return dotGlob(t) ?? claudeChildGlob(t)
}

const PUSH_LONG = ['force', 'mirror', 'delete', 'prune']
const PUSH_WORD = new RegExp(wordRe('push').source, 'g')
function pushArgsReason(t) {
  const short = /(?<= )-[a-z]*[fd][a-z]*(?![a-z0-9_-])/.exec(t) // `-f`, `-uf`, `-f)` (inside `$( )`), not `--follow-tags`
  if (short) return `push ${short[0]}`
  for (const m of t.matchAll(/(?<= )--([a-z-]+)/g)) {
    const name = m[1]
    if (PUSH_LONG.some((l) => l.startsWith(name) || name.startsWith(l))) return `push --${name}`
  }
  const refspec = /(?: \+| :|:\+)/.exec(t)
  return refspec ? `push ${refspec[0].trim() || refspec[0]}` : null
}
function pushRule(t, { cmds = [t] } = {}) {
  if (!has(t, 'push')) return null
  // A77d: the flags are those AFTER a `push` word up to the next separator; `git stash push …` is not `git push`
  // (`git stash push -m "a + b"`, `git fetch --prune origin && git push origin x`). Whole command when an expansion or
  // xargs/parallel can bring flags in from elsewhere.
  for (const seg of cmds) {
    for (const m of seg.matchAll(PUSH_WORD)) {
      if (/(?<![a-z0-9_-])stash +$/.test(seg.slice(0, m.index))) continue
      const tail = seg.slice(m.index + 4)
      const why = pushArgsReason(reachesFromOutside(tail, t) ? t : tail)
      if (why) return why
    }
  }
  return null
}

const GH_VERBS = ['merge', 'create', 'new', 'ready', 'close', 'edit', 'review', 'comment']
function ghRule(t, { pipes = [t] } = {}) {
  if (!has(t, 'gh') || !(has(t, 'pr') || has(t, 'api'))) return null
  const verb = firstWord(t, GH_VERBS)
  if (verb) return `gh pr|api … ${verb}`
  const lit = ['--method', '--field', '--raw-field', '--input', 'method-override'].find((x) => t.includes(x))
  if (lit) return `gh pr|api … ${lit}`
  // A77d: the short write flags (-f -F -X) are scanned in the pipeline segment that holds `gh` (`gh pr diff 5 | grep -F x`,
  // `… | cut -d/ -f1-2`), or in the whole command when text from outside can reach that segment's argv.
  for (const seg of pipes.filter((x) => has(x, 'gh'))) {
    const flag = /(?<= )-[a-z]*[fx]/.exec(reachesFromOutside(seg, t) ? t : seg)
    if (flag) return `gh pr|api … ${flag[0]}`
  }
  return null
}

// A variable NAME is not the subcommand: `cast call 0x0 "f()" "$WALLET"` passes (layer 1 refuses `cast $X …` itself, since the
// subcommand must be a listed word).
const CAST_WORDS = ['send', 'publish', 'mktx', 'wallet', 'erc20']
function castRule(t) {
  if (!has(t, 'cast')) return null
  return CAST_WORDS.find((w) => new RegExp(`(?<![a-z0-9_$-])(?<!\\$\\{)${w}(?![a-z0-9_-])`).test(t)) ?? null
}

const KEYCHAIN_VERB = '(?:find|add|delete|dump|list|import|export|unlock|lock|set|show|create|default|login|remove|authorize|cms|verify|smartcard|translocate|error|help|install|uninstall|leave|execute|authorizationdb)'
// `security` as a command: bare, with flags only (`security -i` reads commands from stdin), or followed by a keychain verb.
// `docs/security/…`, `grep security docs`, `ls docs/security` and a flag VALUE (`git log --grep=security`, A77d) are not commands and pass.
const KEYCHAIN_RE = new RegExp(`(?:(?<![a-z0-9_./=-])|(?<=/s?bin/))security(?=(?: +-[a-z]+)*\\s*(?:$|[;&|)])|(?: +-[a-z]+)* +${KEYCHAIN_VERB}[a-z-]*(?![a-z0-9_]))`)

export const LAYER0_RULES = [
  { id: 'env', why: 'environment-secrets file (only the tracked .env*.example templates are readable)', test: envRule },
  { id: 'harness', why: 'the harness (.claude/settings*, .claude/hooks) is changed by the owner; only pure readers may name it', test: harnessRule },
  { id: 'credentials', why: 'credential access is the owner\'s (CLAUDE.md "Do NOT" #13)', test: (t) => (has(t, 'gh') && has(t, 'auth') ? 'gh auth' : null) ?? (t.includes('--show-token') ? '--show-token' : null) ?? (/git[- ]credential/.exec(t)?.[0] ?? null) },
  { id: 'cast', why: 'cast send / publish / mktx / wallet / erc20 move funds or keys', test: castRule },
  { id: 'broadcast', why: 'forge/cast --broadcast sends transactions', test: (t) => (t.includes('--broadcast') ? '--broadcast' : null) },
  { id: 'push', why: 'force / mirror / delete / +refspec / :refspec pushes', test: pushRule },
  { id: 'gh-write', why: 'gh pr|api writes (merge create new ready close edit review comment, -X --method -f -F --field --raw-field --input, method override)', test: ghRule },
  { id: 'remote-shell', why: 'remote shells and key agents (CLAUDE.md "Do NOT" #15)', test: (t) => /(?<![a-z0-9_-])(?:ssh-copy-id|ssh-add|ssh-agent|ssh|scp|sftp|pm2)(?![a-z0-9_-])/.exec(t)?.[0] ?? null },
  { id: 'keychain', why: 'the macOS keychain (CLAUDE.md "Do NOT" #13)', test: (t) => KEYCHAIN_RE.exec(t)?.[0].trim() ?? null },
  { id: 'upload-pack', why: 'runs a program on the other side of a git transport', test: (t) => ['--upload-pack', '--receive-pack'].find((x) => t.includes(x)) ?? null },
  {
    id: 'history',
    why: 'shell history',
    test: (t) => ['zsh_history', 'zhistory', 'bash_history', 'sh_history', 'histfile', 'fish_history', 'python_history', 'node_repl_history', 'zsh_sessions'].find((x) => t.includes(x))
      ?? (/(?<![a-z0-9_-])\.history(?![a-z0-9_-])/.test(t) ? '.history' : null),
  },
]

/** @returns {string|null} a refusal reason naming the token, or null */
export function rawScan(command) {
  const raw = String(command)
  const rest = loneCommitRemainder(raw)
  const src = rest ?? raw
  const t = normalise(src)
  const pure = rest === null && isPureReader(raw)
  const ctx = { pure, pipes: splitRegions(src, '|'), cmds: splitRegions(src, '|&;\n') }
  for (const rule of LAYER0_RULES) {
    const hit = rule.test(t, ctx)
    if (hit) return `layer 0 raw-text scan (${rule.id}): "${hit}" appears in the command text — ${rule.why}`
  }
  return null
}
