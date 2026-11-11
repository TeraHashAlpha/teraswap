// Shared shell tokenizer for the PreToolUse guards (command-guard.mjs, readonly-guard.mjs).
//
// inspect(command) -> { cmds, problems }
//   cmds      one entry per EFFECTIVE command: { argv, words, base }
//               argv   words with redirections removed, wrappers/assignments/reserved words stripped
//               words  every word of the simple command, redirect targets included (for file-name checks)
//               base   lower-cased basename of argv[0] ("/usr/bin/GIT" -> "git")
//   problems  things the guard cannot inspect and therefore refuses (a bare shell reading stdin, `eval "$X"`)
//
// It splits on && || ; | |& & newlines and ( ) , removes quotes and backslashes, decodes $'..', recurses into
// $( ), backticks, <( ), heredoc bodies with an unquoted delimiter, `sh|bash|zsh -c`, `eval`, `env -S`,
// `find -exec`, `xargs`, `npx X`, `sudo`, `timeout` and friends. Unparseable input THROWS (callers fail closed).
// An expansion ($VAR, ${..}, $(..), $((..)), `..`) is replaced by the marker EXP: its value is unknowable here.
// It is a lexer for refusing accidents and drift, not a shell: see "What this cannot stop" in
// docs/Runbooks/agent-harness.md.

export const EXP = ''
const MAX_DEPTH = 8

export class ParseError extends Error {}

const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'select', 'esac', 'function'])
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'csh', 'tcsh', 'fish'])

/** Lower-cased basename. macOS volumes are case-insensitive, so `GIT` and `.ENV` are the real thing. */
export function baseName(word) {
  const w = String(word).replace(/\/+$/, '')
  return w.slice(w.lastIndexOf('/') + 1).toLowerCase()
}

export const isAllExp = (w) => w.length > 0 && w.replaceAll(EXP, '') === ''

/** Index just after the `)` that matches the `(` at src[i]. */
function scanParen(src, i) {
  let depth = 0
  const pend = [] // heredocs whose body starts after the next newline
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') { j++; continue }
    if (c === "'") {
      const k = src.indexOf("'", j + 1)
      if (k < 0) throw new ParseError('unterminated single quote')
      j = k
      continue
    }
    if (c === '"') {
      j++
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++
        else if (src[j] === '$' && src[j + 1] === '(') j = scanParen(src, j + 1) - 1
        j++
      }
      if (j >= src.length) throw new ParseError('unterminated double quote')
      continue
    }
    if (c === '<' && src[j + 1] === '<' && src[j + 2] !== '<' && src[j - 1] !== '<') {
      // A heredoc inside $( ): its body may hold apostrophes and parentheses (audit A77b M-7), so skip it whole.
      let k = j + 2
      let strip = false
      if (src[k] === '-') { strip = true; k++ }
      while (src[k] === ' ' || src[k] === '\t') k++
      if (k < src.length && /[A-Za-z_'"\\]/.test(src[k])) {
        let delim = ''
        while (k < src.length && !/[\s;&|<>()]/.test(src[k])) {
          const d = src[k]
          if (d === "'" || d === '"') {
            const e = src.indexOf(d, k + 1)
            if (e < 0) throw new ParseError('unterminated heredoc delimiter')
            delim += src.slice(k + 1, e)
            k = e + 1
          } else if (d === '\\') { delim += src[k + 1] ?? ''; k += 2 } else { delim += d; k++ }
        }
        pend.push({ delim, strip })
        j = k - 1
        continue
      }
    }
    if (c === '\n' && pend.length > 0) {
      let p = j + 1
      while (pend.length > 0) {
        const h = pend.shift()
        let found = false
        while (p < src.length) {
          let e = src.indexOf('\n', p)
          if (e < 0) e = src.length
          const line = src.slice(p, e)
          p = Math.min(e + 1, src.length)
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) { found = true; break }
        }
        if (!found) throw new ParseError('unterminated heredoc')
      }
      j = p - 1
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return j + 1
    }
  }
  throw new ParseError('unterminated $(')
}

/** Matching `}` for the `{` at src[i]. */
function scanBrace(src, i) {
  let depth = 0
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') { j++; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return j + 1
    }
  }
  throw new ParseError('unterminated ${')
}

function decodeAnsiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g, (_, e) => {
    if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16))
    if ((e[0] === 'u' || e[0] === 'U') && e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16))
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }[e] ?? e
  })
}

// "git push" style redirections: an operator that takes the NEXT word (>, >>, 2>, <, &>) vs. a self-contained one (>out, 2>&1).
const REDIR_NEEDS_TARGET = /^[\d&]*[<>]+&?$/
const REDIR_SELF = /^[\d&]*[<>]+(?:&\d+|&-|.+)$/
function stripRedirects(words) {
  const out = []
  const redirs = [] // operators and targets (here-strings excluded: their operand is a string, not a file)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (/^<<<$/.test(w)) { i++; continue }
    // `>>` also matches REDIR_SELF (it is `>` + `>`), so the operator-with-a-separate-target form is tested first.
    if (REDIR_NEEDS_TARGET.test(w)) { redirs.push(w); if (words[i + 1] !== undefined) redirs.push(words[i + 1]); i++; continue }
    if (REDIR_SELF.test(w)) { redirs.push(w); continue }
    out.push(w)
  }
  return { out, redirs }
}

/** @returns {{words: string[], argv: string[], redirs: string[]}[]} one entry per simple command, substitutions flattened in */
export function parseCommands(src, depth = 0) {
  if (depth > MAX_DEPTH) throw new ParseError('nesting too deep')
  const n = src.length
  const cmds = []
  let words = []
  let cur = ''
  let inWord = false
  let i = 0
  const pending = [] // heredocs awaiting their body: { delim, strip, expand }

  const endWord = () => {
    if (inWord) { words.push(cur); cur = ''; inWord = false }
  }
  const endCmd = () => {
    endWord()
    if (words.length > 0) { const { out, redirs } = stripRedirects(words); cmds.push({ words, argv: out, redirs }); words = [] }
  }
  const sub = (inner) => { for (const c of parseCommands(inner, depth + 1)) cmds.push(c) }
  /** Run the substitutions found inside a heredoc body or similar free text. */
  const scanText = (text) => {
    for (let k = 0; k < text.length; k++) {
      if (text[k] === '\\') { k++; continue }
      if (text[k] === '$' && text[k + 1] === '(') {
        const end = scanParen(text, k + 1)
        sub(text.slice(k + 2, end - 1))
        k = end - 1
      } else if (text[k] === '`') {
        let e = k + 1
        while (e < text.length && text[e] !== '`') { if (text[e] === '\\') e++; e++ }
        if (e >= text.length) throw new ParseError('unterminated backtick')
        sub(text.slice(k + 1, e).replace(/\\`/g, '`'))
        k = e
      }
    }
  }

  /** `$...` at src[i]. Appends to cur; returns the next index. `dq` = inside double quotes. */
  const dollar = (dq) => {
    const nx = src[i + 1]
    if (nx === '(') {
      const end = scanParen(src, i + 1)
      sub(src.slice(i + 2, end - 1))
      cur += EXP
      inWord = true
      return end
    }
    if (nx === '{') {
      const end = scanBrace(src, i + 1)
      const inner = src.slice(i + 2, end - 1)
      if (inner.includes('$(') || inner.includes('`')) scanText(inner)
      cur += EXP
      inWord = true
      return end
    }
    if (nx === "'" && !dq) {
      let j = i + 2
      while (j < n && src[j] !== "'") { if (src[j] === '\\') j++; j++ }
      if (j >= n) throw new ParseError('unterminated $\'')
      cur += decodeAnsiC(src.slice(i + 2, j))
      inWord = true
      return j + 1
    }
    if (nx !== undefined && /[A-Za-z_]/.test(nx)) {
      let j = i + 2
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++
      cur += EXP
      inWord = true
      return j
    }
    if (nx !== undefined && /[0-9@*#?$!-]/.test(nx)) {
      cur += EXP
      inWord = true
      return i + 2
    }
    cur += '$'
    inWord = true
    return i + 1
  }

  const backtick = () => {
    let j = i + 1
    while (j < n && src[j] !== '`') { if (src[j] === '\\') j++; j++ }
    if (j >= n) throw new ParseError('unterminated backtick')
    sub(src.slice(i + 1, j).replace(/\\`/g, '`'))
    cur += EXP
    inWord = true
    return j + 1
  }

  while (i < n) {
    const c = src[i]
    if (c === '\\') {
      if (i + 1 >= n) { cur += '\\'; inWord = true; i++; continue }
      if (src[i + 1] === '\n') { i += 2; continue }
      cur += src[i + 1]
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      if (j < 0) throw new ParseError('unterminated single quote')
      cur += src.slice(i + 1, j)
      inWord = true
      i = j + 1
      continue
    }
    if (c === '"') {
      inWord = true
      i++
      for (;;) {
        if (i >= n) throw new ParseError('unterminated double quote')
        const d = src[i]
        if (d === '"') { i++; break }
        if (d === '\\') {
          const e = src[i + 1]
          if (e === undefined) throw new ParseError('unterminated double quote')
          if (e === '\n') { i += 2; continue }
          cur += '$`"\\'.includes(e) ? e : `\\${e}`
          i += 2
          continue
        }
        if (d === '$') { i = dollar(true); continue }
        if (d === '`') { i = backtick(); continue }
        cur += d
        i++
      }
      continue
    }
    if (c === '$') { i = dollar(false); continue }
    if (c === '`') { i = backtick(); continue }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue }
    if (c === '\n') {
      endCmd()
      i++
      while (pending.length > 0) {
        const h = pending.shift()
        const lines = []
        let found = false
        while (i < n) {
          let e = src.indexOf('\n', i)
          if (e < 0) e = n
          let line = src.slice(i, e)
          i = Math.min(e + 1, n)
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) { found = true; break }
          lines.push(line)
        }
        if (h.expand) scanText(lines.join('\n'))
        if (!found && i >= n) break
      }
      continue
    }
    if (c === '#' && !inWord) {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '<' || c === '>') {
      if ((src[i + 1] === '(') ) {
        const end = scanParen(src, i + 1)
        sub(src.slice(i + 2, end - 1))
        cur += EXP
        inWord = true
        i = end
        continue
      }
      if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        endWord()
        i += 2
        let strip = false
        if (src[i] === '-') { strip = true; i++ }
        while (src[i] === ' ' || src[i] === '\t') i++
        let delim = ''
        let quoted = false
        while (i < n && !/[\s;&|<>()]/.test(src[i])) {
          const d = src[i]
          if (d === "'" || d === '"') {
            const j = src.indexOf(d, i + 1)
            if (j < 0) throw new ParseError('unterminated heredoc delimiter')
            delim += src.slice(i + 1, j)
            quoted = true
            i = j + 1
          } else if (d === '\\') { delim += src[i + 1] ?? ''; quoted = true; i += 2 } else { delim += d; i++ }
        }
        if (delim === '') throw new ParseError('heredoc without delimiter')
        pending.push({ delim, strip, expand: !quoted })
        continue
      }
      cur += c
      inWord = true
      i++
      continue
    }
    if (c === '&') {
      if (src[i + 1] === '&') { endCmd(); i += 2; continue }
      const prev = src[i - 1]
      if (prev === '>' || prev === '<' || src[i + 1] === '>') { cur += c; inWord = true; i++; continue }
      endCmd()
      i++
      continue
    }
    if (c === '|') { endCmd(); i += src[i + 1] === '|' || src[i + 1] === '&' ? 2 : 1; continue }
    if (c === ';' || c === '(' || c === ')') { endCmd(); i++; continue }
    cur += c
    inWord = true
    i++
  }
  endCmd()
  return cmds
}

// ---------------------------------------------------------------------------------------------------------------
// Wrapper unwrapping

/** Wrappers that run their remaining arguments as a command: options with a value, plus leading positionals. */
const WRAPPERS = {
  builtin: { valued: [] },
  nohup: { valued: [] },
  time: { valued: [] },
  noglob: { valued: [] },
  nocorrect: { valued: [] },
  arch: { valued: ['-arch', '-d', '-e'] },
  setsid: { valued: [] },
  exec: { valued: ['-a'] },
  nice: { valued: ['-n', '--adjustment'] },
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], positional: 1 },
  stdbuf: { valued: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  sudo: { valued: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir', '--chroot'] },
  doas: { valued: ['-u', '-C'] },
  caffeinate: { valued: ['-t', '-w'] },
  xargs: { valued: ['-a', '-d', '-E', '-I', '-J', '-L', '-n', '-P', '-R', '-S', '-s', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--max-chars'] },
}
const RUNNER_VALUED = ['-p', '--package', '-w', '--workspace', '--cache', '--registry', '--prefix', '--userconfig']

function skipOptions(a, spec) {
  let k = 1
  while (k < a.length) {
    const t = a[k]
    if (t === '--') { k++; break }
    if (t === '-' || !t.startsWith('-')) break
    k += spec.valued.includes(t) ? 2 : 1
  }
  return a.slice(k + (spec.positional ?? 0))
}

/** @returns {{cmds: {argv: string[], words: string[], base: string}[], problems: string[]}} */
export function inspect(command) {
  const cmds = []
  const problems = []

  const walk = (str, depth) => {
    if (depth > MAX_DEPTH) throw new ParseError('nesting too deep')
    for (const c of parseCommands(str, depth)) {
      // Redirect targets are checked for EVERY simple command, compound-command closers (`done < .env`, `) < f`, `} < f`)
      // and wrappers (`sh -c '…' < .env`) included: handle() may return before it ever pushes this command (A77b H-5).
      if (c.redirs.length > 0) cmds.push({ argv: [], words: c.redirs, base: '', redirOnly: true })
      handle(c.argv, c.words, depth)
    }
  }

  const handle = (argv, words, depth) => {
    let a = argv.slice()
    for (let guard = 0; guard < 64; guard++) {
      while (a.length > 0 && (RESERVED.has(a[0]) || ASSIGN.test(a[0]))) a.shift()
      if (a.length === 0) return
      if (isAllExp(a[0])) { problems.push('the command name is built from an expansion'); return }
      const base = baseName(a[0])

      if (base === 'env') {
        let k = 1
        for (; k < a.length; k++) {
          const t = a[k]
          if (t === '--') { k++; break }
          if (ASSIGN.test(t)) continue
          if (t === '-S' || t === '--split-string') { walk([a[k + 1] ?? '', ...a.slice(k + 2)].join(' '), depth + 1); return }
          if (t.startsWith('-S') && t.length > 2) { walk([t.slice(2), ...a.slice(k + 1)].join(' '), depth + 1); return }
          if (t.startsWith('--split-string=')) { walk([t.slice(15), ...a.slice(k + 1)].join(' '), depth + 1); return }
          if (['-u', '--unset', '-C', '--chdir', '-P'].includes(t)) { k++; continue }
          if (t.startsWith('-') && t !== '-') continue
          break
        }
        a = a.slice(k)
        continue
      }
      if (base === 'command') {
        const rest = a.slice(1)
        let k = 0
        let lookup = false
        for (; k < rest.length && rest[k].startsWith('-') && rest[k] !== '-'; k++) {
          if (rest[k] === '--') { k++; break }
          if (/^-[a-zA-Z]*[vV]/.test(rest[k])) lookup = true
        }
        if (lookup) return // `command -v ssh` only looks the name up
        a = rest.slice(k)
        continue
      }
      if (WRAPPERS[base]) { a = skipOptions(a, WRAPPERS[base]); continue }

      if (base === 'script' || base === 'coproc') {
        problems.push(`${base} runs another command through a wrapper the guard cannot unwrap`)
        return
      }

      // npx X, pnpx X, bunx X; `npm|pnpm|yarn|bun exec|x|dlx X`; and (A77b lows) `pnpm|yarn|bun X` / `… run X`, which
      // run a bin from node_modules/.bin exactly like npx does. For those three the package-manager command itself is
      // inspected too (so `pnpm audit --fix` still reaches the audit rule), X is inspected in addition.
      let runner = null
      let alsoSelf = false
      if (base === 'npx' || base === 'pnpx' || base === 'bunx') runner = a.slice(1)
      else if (['npm', 'pnpm', 'yarn', 'bun'].includes(base) && ['exec', 'x', 'dlx'].includes(a[1])) runner = a.slice(2)
      else if (['pnpm', 'yarn', 'bun'].includes(base) && a[1] !== undefined && !a[1].startsWith('-')) {
        runner = a[1] === 'run' || a[1] === 'run-script' ? a.slice(2) : a.slice(1)
        alsoSelf = true
      }
      if (runner !== null) {
        let k = 0
        let called = null
        for (; k < runner.length; k++) {
          const t = runner[k]
          if (t === '--') { k++; break }
          if (t === '-c' || t === '--call') { called = runner[k + 1] ?? ''; break }
          if (t.startsWith('--call=')) { called = t.slice(7); break }
          if (t === '-' || !t.startsWith('-')) break
          if (RUNNER_VALUED.includes(t)) k++
        }
        if (called !== null) { walk(called, depth + 1); return }
        if (alsoSelf) {
          if (runner.slice(k).length > 0) handle(runner.slice(k), words, depth + 1)
          cmds.push({ argv: a, words, base })
          return
        }
        a = runner.slice(k)
        continue
      }

      if (SHELLS.has(base)) {
        let k = 1
        let hasC = false
        let hasS = false
        for (; k < a.length; k++) {
          const t = a[k]
          if (t === '--') { k++; break }
          if (t.startsWith('--')) { if (t === '--rcfile' || t === '--init-file') k++; continue }
          if (/^[-+]./.test(t)) {
            if (t[0] === '-') { if (t.includes('c')) hasC = true; if (t.includes('s')) hasS = true }
            if (/[oO]/.test(t)) k++ // `-o pipefail`, `-O extglob`
            continue
          }
          break
        }
        if (hasC) {
          const script = a[k]
          if (script === undefined || isAllExp(script)) problems.push(`${base} -c with a script that is built from an expansion`)
          else walk(script, depth + 1)
          return
        }
        if (hasS || k >= a.length) { problems.push(`${base} would read commands from stdin, which cannot be inspected`); return }
        // `bash script.sh`: the script body is outside the command text (documented gap); keep the argv for file checks.
        cmds.push({ argv: a, words, base })
        return
      }
      if (base === 'eval') {
        const text = a.slice(1).join(' ')
        if (isAllExp(text.trim()) || text.trim() === '') problems.push('eval of an expansion cannot be inspected')
        else walk(text, depth + 1)
        return
      }
      if (base === 'find') {
        for (let k = 1; k < a.length; k++) {
          if (['-exec', '-execdir', '-ok', '-okdir'].includes(a[k])) {
            let e = k + 1
            while (e < a.length && a[e] !== ';' && a[e] !== '+') e++
            handle(a.slice(k + 1, e), words, depth + 1)
          }
        }
      }
      cmds.push({ argv: a, words, base })
      return
    }
    problems.push('wrapper nesting too deep')
  }

  walk(String(command), 0)
  return { cmds, problems }
}
