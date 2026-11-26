import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, statSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-verify.sh')
const ORDER = ['suite', 'lint-delta', 'tsc', 'build', 'v1v2-parity', 'rpc-budget', 'codeql', 'keeper']

let dir
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'agent-verify-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const tsv = (rows) => rows.map((r) => r.join('\t')).join('\n') + '\n'
function format(rows, extraEnv = {}) {
  const f = path.join(dir, `r-${Math.random().toString(36).slice(2)}.tsv`)
  writeFileSync(f, tsv(rows))
  return spawnSync('bash', [SCRIPT, '--format', f], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_VERIFY_OUT: dir, ...extraEnv },
  })
}
const PASS = [
  ['suite', 'PASS', '3814 tests passed, 0 failed, 265 files'],
  ['lint-delta', 'PASS', 'errors +0, warnings +0 (3 changed files)'],
  ['tsc', 'PASS', '0 errors'],
  ['build', 'PASS', 'next build ok'],
  ['v1v2-parity', 'PASS', '120 tests passed, 0 failed, 9 files'],
  ['rpc-budget', 'PASS', '14 tests passed, 0 failed, 2 files'],
]
const lineOf = (out, name) => out.split('\n').find((l) => l.startsWith(`${name}:`))

describe('agent-verify EVIDENCE formatter', () => {
  it('prints the fixed block, one line per check in fixed order, exit 0 when nothing failed', () => {
    const r = format(PASS)
    expect(r.status).toBe(0)
    const lines = r.stdout.split('\n')
    expect(lines[0]).toBe('=== EVIDENCE ===')
    expect(lines[1]).toMatch(/^branch: .+ @ [0-9a-f]+ \(base origin\/main @ /)
    const idx = ORDER.map((n) => lines.findIndex((l) => l.startsWith(`${n}:`)))
    expect(idx.every((i) => i > 1)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(r.stdout).toMatch(/^suite:\s+PASS\s+3814 tests passed/m)
    expect(r.stdout).toMatch(/^codeql:\s+SKIP\s+not requested/m)
    expect(r.stdout).toMatch(/^keeper:\s+SKIP\s+not requested/m)
    expect(r.stdout).toContain('diff --stat origin/main...HEAD:')
    expect(r.stdout).toMatch(/^compare: (https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/compare\/main\.\.\.\S+|unavailable)$/m)
    expect(r.stdout).toContain('RESULT: PASS')
    expect(lines.filter(Boolean).at(-1)).toBe('=== END EVIDENCE ===')
  })

  it('a FAIL check makes RESULT FAIL and the exit code non-zero', () => {
    const rows = PASS.map((r) => (r[0] === 'tsc' ? ['tsc', 'FAIL', '2 errors'] : r))
    const r = format(rows)
    expect(r.status).toBe(1)
    expect(lineOf(r.stdout, 'tsc')).toMatch(/FAIL\s+2 errors/)
    expect(r.stdout).toContain('RESULT: FAIL (1 failed)')
  })

  it('a check that never reported is FAIL "not run" (missing evidence is not a pass)', () => {
    const r = format(PASS.filter((x) => x[0] !== 'build'))
    expect(r.status).toBe(1)
    expect(lineOf(r.stdout, 'build')).toMatch(/FAIL\s+not run/)
  })

  it('requested codeql/keeper results are shown, and a FAIL there fails the run', () => {
    const ok = format([...PASS, ['codeql', 'PASS', 'head 13, base 13, new 0'], ['keeper', 'PASS', 'node20:25-pass/0-fail/0-cancelled']])
    expect(ok.status).toBe(0)
    expect(lineOf(ok.stdout, 'codeql')).toMatch(/PASS\s+head 13, base 13/)
    const bad = format([...PASS, ['keeper', 'FAIL', 'node20:MISSING']])
    expect(bad.status).toBe(1)
    expect(lineOf(bad.stdout, 'keeper')).toMatch(/FAIL\s+node20:MISSING/)
  })

  it('treats any unknown status as FAIL and uses the last record per check', () => {
    const weird = format(PASS.map((r) => (r[0] === 'suite' ? ['suite', 'OK??', 'x'] : r)))
    expect(weird.status).toBe(1)
    expect(lineOf(weird.stdout, 'suite')).toMatch(/FAIL/)
    const retried = format([['suite', 'FAIL', 'first'], ...PASS])
    expect(retried.status).toBe(0)
  })

  it('never prints environment values', () => {
    const r = format(PASS, { AGENT_VERIFY_SECRET_PROBE: 'hunter2-should-never-print', GH_TOKEN: 'ghp_probe_value_123' })
    expect(r.stdout + r.stderr).not.toContain('hunter2-should-never-print')
    expect(r.stdout + r.stderr).not.toContain('ghp_probe_value_123')
  })

  it('exits 2 on an unknown flag or a missing results file', () => {
    expect(spawnSync('bash', [SCRIPT, '--nope'], { encoding: 'utf8' }).status).toBe(2)
    expect(spawnSync('bash', [SCRIPT, '--format', path.join(dir, 'missing.tsv')], { encoding: 'utf8' }).status).toBe(2)
  })

  it('is executable', () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0)
  })
})

describe('agent-verify with tools missing (fails closed)', () => {
  it('reports FAIL "missing tool" for every check and exits non-zero, including --codeql/--keeper', () => {
    // A PATH holding only the basics the script itself needs — no node, npm, npx, gh.
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    for (const t of ['bash', 'git', 'sed', 'awk', 'grep', 'wc', 'tr', 'head', 'tail', 'sort', 'comm', 'mktemp', 'mkdir', 'dirname', 'cat', 'uname']) {
      try {
        const p = execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim()
        if (p.startsWith('/')) symlinkSync(p, path.join(bin, t))
      } catch {}
    }
    const out = path.join(dir, 'out-missing')
    const r = spawnSync(path.join(bin, 'bash'), [SCRIPT, '--codeql', '--keeper'], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: dir, AGENT_VERIFY_OUT: out },
    })
    expect(r.status).toBe(1)
    for (const n of ['suite', 'tsc', 'build', 'v1v2-parity', 'rpc-budget', 'codeql', 'keeper']) {
      expect(lineOf(r.stdout, n), n).toMatch(/FAIL\s+missing tool: /)
    }
    expect(r.stdout).toContain('RESULT: FAIL (8 failed)')
  })
})

describe('agent-verify --keeper (CI Node majors, fake installs)', () => {
  // Run the script's real helper + check_keeper functions against a fake repo and fake Node installs.
  const fakeNode = (file, major, pass = 5, fail = 0) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `#!/bin/sh\ncase "$1" in -p) echo ${major};; --test) printf '# pass ${pass}\\n# fail ${fail}\\n# cancelled 0\\n';; esac\nexit ${fail ? 1 : 0}\n`)
    chmodSync(file, 0o755)
  }
  // find_node_major also tries absolute Homebrew prefixes (/opt/homebrew/opt, /usr/local/opt) that a fake HOME/PATH cannot
  // hide: on a machine with brew node@20/node@22 installed the "fake install" runs found the REAL binaries (0-pass, no
  // MISSING). Re-root those two prefixes under the fake home, in the test's copy of the function only; the script's own
  // lookup is untouched. The asserts make this fail loudly if the script stops listing them, instead of silently going
  // back to reading the machine.
  const ABS_PREFIXES = ['/opt/homebrew/opt/', '/usr/local/opt/']
  const isolateAbsoluteCandidates = (fn, home) => {
    for (const p of ABS_PREFIXES) expect(fn, `find_node_major no longer lists ${p}: update the test isolation`).toContain(p)
    return ABS_PREFIXES.reduce((acc, p) => acc.split(p).join(path.join(home, 'abs', p)), fn)
  }
  const wf = (v) => `jobs:\n  keeper-suite:\n    steps:\n      - with:\n          node-version: "${v}"\n`
  function keeper(home, { ci = '22', kt = '20' } = {}) {
    const root = path.join(home, 'repo')
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true })
    mkdirSync(path.join(root, 'contracts/order-engine/executor/node_modules'), { recursive: true })
    // another ci.yml job on a different Node must NOT be counted
    writeFileSync(path.join(root, '.github/workflows/ci.yml'), `jobs:\n  other:\n    steps:\n      - with:\n          node-version: "18"\n` + wf(ci).replace('jobs:\n', ''))
    writeFileSync(path.join(root, '.github/workflows/keeper-tests.yml'), wf(kt))
    const src = readFileSync(SCRIPT, 'utf8')
    const lines = src.split('\n')
    const cut = (from, to) => lines.slice(lines.findIndex((l) => l.startsWith(from)), lines.findIndex((l) => l.startsWith(to))).join('\n')
    const prog = [
      'set -u',
      `ROOT=${JSON.stringify(root)}; OUT=${JSON.stringify(home)}; RESULTS=${JSON.stringify(path.join(home, 'res.tsv'))}`,
      'KEEPER_DIR="contracts/order-engine/executor"; KEEPER_WORKFLOW=".github/workflows/keeper-tests.yml"',
      'KEEPER_CI_WORKFLOW=".github/workflows/ci.yml"; KEEPER_CI_JOB="keeper-suite"',
      cut('record()', '# ---------- checks'),
      isolateAbsoluteCandidates(cut('find_node_major()', '# ---------- formatter'), home),
      'check_keeper',
      'cat "$RESULTS"',
    ].join('\n')
    // PATH has no `node`, only what check_keeper's `need node npm` requires, via stubs in <home>/bin.
    const bin = path.join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    for (const t of ['node', 'npm']) { writeFileSync(path.join(bin, t), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(bin, t), 0o755) }
    const base = execFileSync('bash', ['-c', 'dirname "$(command -v sed)"'], { encoding: 'utf8' }).trim()
    return spawnSync('bash', ['-c', prog], {
      encoding: 'utf8',
      env: { HOME: home, PATH: `${bin}:${base}:/usr/bin:/bin`, NVM_DIR: path.join(home, '.nvm') },
    })
  }
  const mk = () => mkdtempSync(path.join(dir, 'k-'))

  it('uses ci.yml keeper-suite job + keeper-tests.yml (not other ci.yml jobs): both majors found via nvm/fnm/volta -> PASS', () => {
    const h = mk()
    fakeNode(path.join(h, '.nvm/versions/node/v22.3.0/bin/node'), 22)
    fakeNode(path.join(h, '.volta/tools/image/node/20.11.1/bin/node'), 20)
    const r = keeper(h)
    expect(r.stdout).toMatch(/^keeper\tPASS\tnode20:5-pass\/0-fail\/0-cancelled node22:5-pass\/0-fail\/0-cancelled$/m)
    expect(r.stdout).not.toContain('node18')
  })

  it('finds fnm installs (Library/Application Support layout)', () => {
    const h = mk()
    fakeNode(path.join(h, 'Library/Application Support/fnm/node-versions/v22.1.0/installation/bin/node'), 22)
    fakeNode(path.join(h, '.local/share/fnm/node-versions/v20.9.0/installation/bin/node'), 20)
    expect(keeper(h).stdout).toMatch(/^keeper\tPASS\t/m)
  })

  it('a missing major is FAIL, never substituted, and names only the missing majors; it never tells an agent to install anything', () => {
    const h = mk()
    fakeNode(path.join(h, '.nvm/versions/node/v22.3.0/bin/node'), 22)
    const r = keeper(h)
    const line = r.stdout.split('\n').find((l) => l.startsWith('keeper\t'))
    expect(line).toMatch(/^keeper\tFAIL\t/)
    expect(line).toContain('node20:MISSING')
    expect(line).toContain('node22:5-pass')
    expect(line).toContain('Missing Node major(s): 20; ask the owner to install them; do not install anything yourself')
    expect(line).not.toContain('22;') // node22 was found: it is not listed as missing
    const both = keeper(mk()).stdout.split('\n').find((l) => l.startsWith('keeper\t'))
    expect(both).toContain('Missing Node major(s): 20, 22; ask the owner to install them; do not install anything yourself')
    // 2026-11-14: an agent followed a `brew install node@20 node@22` hint and broke the shared Node. No install command, ever.
    for (const l of [line, both]) expect(l).not.toMatch(/brew|install:|install node|npm i|nvm install|fnm install|volta install/i)
  })

  it('the script source has no install command for an agent to copy (the lookup may still call `brew --prefix`)', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).not.toMatch(/brew\s+(install|upgrade|reinstall)/)
    expect(src).toContain('ask the owner to install them; do not install anything yourself')
  })

  it('the machine-wide Homebrew prefixes are still candidates (re-rooted under the fake home here), and nothing real leaks in', () => {
    const h = mk()
    fakeNode(path.join(h, 'abs/opt/homebrew/opt/node@22/bin/node'), 22)
    fakeNode(path.join(h, 'abs/usr/local/opt/node@20/bin/node'), 20)
    expect(keeper(h).stdout).toMatch(/^keeper\tPASS\tnode20:5-pass\/0-fail\/0-cancelled node22:5-pass\/0-fail\/0-cancelled$/m)
    // with no fake install at all, both majors are MISSING whatever brew/nvm/fnm installs the real machine has
    const none = keeper(mk()).stdout.split('\n').find((l) => l.startsWith('keeper\t'))
    expect(none).toMatch(/^keeper\tFAIL\tnode20:MISSING node22:MISSING/)
  })

  it('a failing or cancelled test on one major is FAIL', () => {
    const h = mk()
    fakeNode(path.join(h, '.nvm/versions/node/v22.3.0/bin/node'), 22, 5, 1)
    fakeNode(path.join(h, '.nvm/versions/node/v20.1.0/bin/node'), 20)
    expect(keeper(h).stdout).toMatch(/^keeper\tFAIL\t.*node22:5-pass\/1-fail/m)
  })
})

// ---- A77 M-3 / M-4 / M-5 ----------------------------------------------------------------------------------------
function sarif(file, results) {
  const f = path.join(dir, file)
  writeFileSync(f, JSON.stringify({ runs: [{ results: results.map(([ruleId, uri, text, line]) => ({ ruleId, message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line ?? 1 } } }] })) }] }))
  return f
}
const cqDiff = (head, base) => spawnSync('bash', [SCRIPT, '--codeql-diff', head, base], { encoding: 'utf8' })

describe('agent-verify codeql compares alerts by rule + file + message (M-5)', () => {
  const a = ['js/x', 'src/a.ts', 'Alert A']
  const b = ['js/y', 'src/b.ts', 'Alert B']
  it('same alerts, moved lines -> 0 new', () => {
    const r = cqDiff(sarif('h1.sarif', [[...a, 10], [...b, 7]]), sarif('b1.sarif', [[...a, 99], [...b, 3]]))
    expect(r.stdout.trim()).toBe('2 2 0')
  })
  it('one alert swapped for another keeps the total equal but is 1 new', () => {
    const r = cqDiff(sarif('h2.sarif', [a, ['js/z', 'src/c.ts', 'New alert']]), sarif('b2.sarif', [a, b]))
    expect(r.stdout.trim()).toBe('2 2 1')
  })
  it('same rule and file but a different message is new; an extra duplicate is new; fewer alerts is 0 new', () => {
    expect(cqDiff(sarif('h3.sarif', [['js/x', 'src/a.ts', 'Other message']]), sarif('b3.sarif', [a])).stdout.trim()).toBe('1 1 1')
    expect(cqDiff(sarif('h4.sarif', [a, a]), sarif('b4.sarif', [a])).stdout.trim()).toBe('2 1 1')
    expect(cqDiff(sarif('h5.sarif', [a]), sarif('b5.sarif', [a, b])).stdout.trim()).toBe('1 2 0')
  })
  it('unreadable SARIF is a usage error, not a pass', () => {
    expect(cqDiff(path.join(dir, 'nope1'), path.join(dir, 'nope2')).status).toBe(2)
    const bad = path.join(dir, 'bad.sarif')
    writeFileSync(bad, 'not json')
    expect(cqDiff(bad, bad).status).not.toBe(0)
  })
})

describe('agent-verify compare line (M-4)', () => {
  // Run the formatter from a throw-away repo so `git remote get-url origin` is ours.
  function compareFor(origin, branch = 'chore/agent-harness') {
    const repo = mkdtempSync(path.join(dir, 'repo-'))
    mkdirSync(path.join(repo, 'scripts'))
    writeFileSync(path.join(repo, 'scripts', 'agent-verify.sh'), readFileSync(SCRIPT))
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    git('init', '-q', '-b', branch)
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x')
    if (origin) git('remote', 'add', 'origin', origin)
    const f = path.join(dir, `c-${Math.random().toString(36).slice(2)}.tsv`)
    writeFileSync(f, tsv(PASS))
    const r = spawnSync('bash', [path.join(repo, 'scripts', 'agent-verify.sh'), '--format', f], { encoding: 'utf8', env: { ...process.env, AGENT_VERIFY_OUT: dir } })
    return { line: lineOf(r.stdout, 'compare'), all: r.stdout + r.stderr }
  }
  it.each([
    ['https://github.com/TeraHashAlpha/teraswap.git'],
    ['https://github.com/TeraHashAlpha/teraswap'],
    ['git@github.com:TeraHashAlpha/teraswap.git'],
    ['ssh://git@github.com/TeraHashAlpha/teraswap.git'],
    ['https://x-access-token:ghs_SECRET123@github.com/TeraHashAlpha/teraswap.git'],
    ['https://user:p%40ss@github.com/TeraHashAlpha/teraswap.git'],
  ])('github.com origin %s -> a plain link, never the credentials', (origin) => {
    const { line, all } = compareFor(origin)
    expect(line).toBe('compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/agent-harness')
    expect(all).not.toMatch(/SECRET123|p%40ss|x-access-token|user:/)
  })
  it.each([
    [null],
    ['https://gitlab.com/o/r.git'],
    ['https://evil.example/github.com/o/r.git'],
    ['https://github.com.evil.example/o/r.git'],
    ['https://token@bitbucket.org/o/r.git'],
    ['/some/local/path/repo.git'],
    ['https://github.com/only-owner'],
    ['https://u:a@b@github.com/o/r.git'],
  ])('non-github or malformed origin %s -> "unavailable", no URL', (origin) => {
    const { line, all } = compareFor(origin)
    expect(line).toBe('compare: unavailable')
    expect(all).not.toMatch(/token|a@b|https:\/\/github\.com\/o/)
  })
  it('a detached HEAD or an odd branch name is "unavailable"', () => {
    expect(compareFor('https://github.com/o/r.git', 'weird$name').line).toBe('compare: unavailable')
  })
})

describe('agent-verify uses npx --no-install and treats a missing tool as FAIL (M-3)', () => {
  const text = readFileSync(SCRIPT, 'utf8')
  it('never calls a bare `npx <tool>`', () => {
    const calls = text.split('\n').filter((l) => /\bnpx\s/.test(l) && !l.trimStart().startsWith('#') && !/need npx/.test(l))
    expect(calls.length).toBeGreaterThan(0)
    for (const l of calls) expect(l, l).toMatch(/npx --no-install /)
  })
  it('a project without node_modules: suite and tsc are FAIL "missing tool: vitest/tsc", not a download', () => {
    const repo = mkdtempSync(path.join(dir, 'nomod-'))
    mkdirSync(path.join(repo, 'scripts'))
    writeFileSync(path.join(repo, 'scripts', 'agent-verify.sh'), readFileSync(SCRIPT))
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'true' } }))
    const r = spawnSync('bash', [path.join(repo, 'scripts', 'agent-verify.sh')], { encoding: 'utf8', env: { ...process.env, AGENT_VERIFY_OUT: path.join(dir, 'out-nomod'), npm_config_offline: 'true' }, timeout: 120000 })
    expect(r.status).toBe(1)
    expect(lineOf(r.stdout, 'suite')).toMatch(/FAIL\s+missing tool: vitest/)
    expect(lineOf(r.stdout, 'tsc')).toMatch(/FAIL\s+missing tool: tsc/)
  }, 150000)
})

// ---- pinned CodeQL pack + tool failure --------------------------------------------------------------------------------
describe('agent-verify --codeql: pinned query pack and tool failure', () => {
  const LOCAL = path.join(path.dirname(SCRIPT), 'codeql-local.sh')
  const localText = readFileSync(LOCAL, 'utf8')
  const PIN = /^CODEQL_JS_PACK_VERSION="\$\{CODEQL_JS_PACK_VERSION:-([0-9]+\.[0-9]+\.[0-9]+)\}"$/m.exec(localText)?.[1]
  const STUB = [
    '#!/bin/sh',
    'echo "$*" >> "$STUB_LOG"',
    'case "$1 $2 $3" in',
    '  "codeql version "*) if [ "$3" = "--format=terse" ]; then echo 9.9.9; else echo "CodeQL command-line toolchain release 9.9.9."; fi ;;',
    '  "codeql pack download") ;;',
    '  "codeql resolve extensions") if [ -n "${STUB_RESOLVE_FAIL:-}" ]; then echo "Invalid data extension file" >&2; exit 2; fi ;;',
    '  "codeql database create") mkdir -p "$4" ;;',
    '  "codeql database analyze") for a in "$@"; do case "$a" in --output=*) out="${a#--output=}";; esac; done; printf \'{"runs":[{"results":[]}]}\' > "$out" ;;',
    'esac',
    '',
  ].join('\n')

  // A throw-away git repo holding the two real scripts, a stub `gh` on PATH, and the script's own check_codeql functions.
  function rig({ resolveFail = false, extraEnv = {} } = {}) {
    const home = mkdtempSync(path.join(dir, 'cq-'))
    const repo = path.join(home, 'repo')
    mkdirSync(path.join(repo, 'scripts'), { recursive: true })
    writeFileSync(path.join(repo, 'scripts', 'codeql-local.sh'), readFileSync(LOCAL), { mode: 0o755 })
    const bin = path.join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'gh'), STUB, { mode: 0o755 })
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('add', 'scripts')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x')
    const log = path.join(home, 'gh.log')
    const lines = readFileSync(SCRIPT, 'utf8').split('\n')
    const cut = (from, to) => lines.slice(lines.findIndex((l) => l.startsWith(from)), lines.findIndex((l) => l.startsWith(to))).join('\n')
    const prog = [
      'set -u; set -o pipefail',
      `ROOT=${JSON.stringify(repo)}; OUT=${JSON.stringify(home)}; RESULTS=${JSON.stringify(path.join(home, 'res.tsv'))}; BASE_REF=HEAD`,
      'CODEQL_QLS="codeql/javascript-queries:codeql-suites/javascript-security-extended.qls"',
      cut('record()', '# ---------- checks'),
      cut('CODEQL_DIFF_JS=', 'find_node_major()'),
      'check_codeql',
      'cat "$RESULTS"',
    ].join('\n')
    const nodeDir = path.dirname(execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim())
    const r = spawnSync('bash', ['-c', prog], {
      encoding: 'utf8',
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:${nodeDir}`, STUB_LOG: log, ...(resolveFail ? { STUB_RESOLVE_FAIL: '1' } : {}), ...extraEnv },
    })
    const calls = (() => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean) } catch { return [] } })()
    return { r, calls, home, row: r.stdout.split('\n').find((l) => l.startsWith('codeql\t')) }
  }

  it('the pin is ONE variable at the top of codeql-local.sh, a plain x.y.z, env-overridable', () => {
    expect(PIN).toMatch(/^\d+\.\d+\.\d+$/)
    expect(localText.split('\n').filter((l) => /^\s*CODEQL_JS_PACK_VERSION=/.test(l))).toHaveLength(1) // one assignment, no second copy
    expect(localText.split('\n').filter((l) => /\b[0-9]+\.[0-9]+\.[0-9]+\b/.test(l) && !l.trimStart().startsWith('#'))).toHaveLength(1) // and no other literal version in code
    expect(localText.indexOf('CODEQL_JS_PACK_VERSION=')).toBeLessThan(localText.indexOf('gh codeql pack download'))
  })

  it('pack not readable by the CLI: ONE tool-failure record with both versions, FAIL, no database create, base never built', () => {
    const { r, calls, home, row } = rig({ resolveFail: true })
    expect(r.stdout.split('\n').filter((l) => l.startsWith('codeql\t'))).toHaveLength(1)
    expect(row).toBe(`codeql\tFAIL\ttool failure: codeql-local: TOOL FAILURE: pack ${PIN} not readable by CLI 9.9.9`)
    expect(calls.filter((c) => c.startsWith('codeql resolve extensions'))).toHaveLength(1) // head only: no second attempt for base
    expect(calls.filter((c) => c.startsWith('codeql database create'))).toHaveLength(0)
    expect(calls.filter((c) => c.startsWith('codeql pack download'))).toHaveLength(1)
    expect(() => readFileSync(path.join(home, 'cq-base.log'))).toThrow()
    // a FAIL row never passes the run
    const f = format([...PASS, ['codeql', 'FAIL', row.split('\t')[2]]])
    expect(f.status).toBe(1)
    expect(lineOf(f.stdout, 'codeql')).toMatch(/FAIL\s+tool failure: codeql-local: TOOL FAILURE: pack .* not readable by CLI 9\.9\.9/)
  })

  it('codeql-local.sh itself exits 3 with exactly the one stderr line', () => {
    const home = mkdtempSync(path.join(dir, 'cql-'))
    const bin = path.join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'gh'), STUB, { mode: 0o755 })
    const r = spawnSync('bash', [LOCAL, 'codeql/javascript-queries:codeql-suites/javascript-security-extended.qls'], {
      encoding: 'utf8',
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: path.join(home, 'l'), STUB_RESOLVE_FAIL: '1', CODEQL_OUT: path.join(home, 'out') },
    })
    expect(r.status).toBe(3)
    expect(r.stderr.trim()).toBe(`codeql-local: TOOL FAILURE: pack ${PIN} not readable by CLI 9.9.9`)
  })

  it('success: download, resolve and analyze all carry the pinned version; the summary names pack and CLI', () => {
    const { calls, row } = rig()
    expect(calls).toContain(`codeql pack download codeql/javascript-queries@${PIN}`)
    const analyze = calls.filter((c) => c.startsWith('codeql database analyze'))
    expect(analyze).toHaveLength(2) // head + base
    for (const c of analyze) expect(c).toContain(`codeql/javascript-queries@${PIN}:codeql-suites/javascript-security-extended.qls`)
    expect(calls.find((c) => c.startsWith('codeql resolve extensions'))).toContain(`codeql/javascript-queries@${PIN}:`)
    // no reference to the pack anywhere is unpinned
    for (const c of calls.filter((c) => c.includes('javascript-queries'))) expect(c.replace(`javascript-queries@${PIN}`, '')).not.toContain('javascript-queries')
    expect(row.startsWith('codeql\tPASS\t')).toBe(true)
    expect(row.endsWith(`(pack ${PIN}, CLI 9.9.9)`)).toBe(true)
  })

  it('CODEQL_JS_PACK_VERSION overrides the version in the download AND the query references', () => {
    const { calls, row } = rig({ extraEnv: { CODEQL_JS_PACK_VERSION: '7.8.9' } })
    expect(calls).toContain('codeql pack download codeql/javascript-queries@7.8.9')
    for (const c of calls.filter((c) => c.includes('javascript-queries'))) {
      expect(c).toContain('javascript-queries@7.8.9')
      expect(c).not.toContain(`@${PIN}`)
    }
    expect(row).toContain('(pack 7.8.9, CLI 9.9.9)')
  })
})

// ---- lint-delta: CI's own `npm run lint`, and a crashed eslint is a FAIL ----------------------------------------------
// A throw-away repo whose node_modules/.bin/eslint is a stub. The stub acts on `stub.json` in the tree it runs in, so the
// base commit and the head commit can behave differently, as two real trees do. git, npm and `npm run` are real.
describe('agent-verify lint-delta', () => {
  const ESLINT_STUB = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const args = process.argv.slice(2)',
    "fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\\n')",
    "const mode = JSON.parse(fs.readFileSync('stub.json', 'utf8'))",
    'if (mode.crash) {',
    '  process.stderr.write(\'\\nOops! Something went wrong! :(\\n\\nESLint: 9.39.5\\n\\nTypeError: node.params is not iterable\\nOccurred while linting \' +',
    "    path.join(process.cwd(), 'scripts/x.d.mts') + ':5\\nRule: \"@typescript-eslint/no-unused-vars\"\\n    at visit (rules.js:1:1)\\n')",
    '  process.exitCode = 2',
    '} else {',
    "  const out = args[args.indexOf('--output-file') + 1]",
    '  const report = Object.entries(mode.files ?? {})',
    '    .filter(([f]) => fs.existsSync(f))',
    '    .map(([f, [errorCount, warningCount]]) => ({ filePath: path.join(process.cwd(), f), errorCount, warningCount, fatalErrorCount: 0 }))',
    '  if (!mode.noReport) fs.writeFileSync(out, JSON.stringify(report))',
    '  process.exitCode = mode.exit ?? 0',
    '}',
    '',
  ].join('\n')

  // base / head: { stub: <stub.json>, files: [tracked paths] }
  function lintDelta(base, head, { noEslint = false, lintScript = 'eslint . --max-warnings 94', before } = {}) {
    const home = mkdtempSync(path.join(dir, 'ld-'))
    const repo = path.join(home, 'repo')
    const out = path.join(home, 'out')
    mkdirSync(path.join(repo, 'node_modules/.bin'), { recursive: true })
    mkdirSync(out)
    if (!noEslint) writeFileSync(path.join(repo, 'node_modules/.bin/eslint'), ESLINT_STUB, { mode: 0o755 })
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n')
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', scripts: { lint: lintScript } }))
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const commit = (tree) => {
      for (const f of git('ls-files', 'src').split('\n').filter(Boolean)) if (!tree.files.includes(f)) rmSync(path.join(repo, f))
      for (const f of tree.files) {
        mkdirSync(path.dirname(path.join(repo, f)), { recursive: true })
        writeFileSync(path.join(repo, f), `// ${f}\n`)
      }
      writeFileSync(path.join(repo, 'stub.json'), JSON.stringify(tree.stub))
      git('add', '-A')
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x')
    }
    git('init', '-q', '-b', 'main')
    commit(base)
    const baseSha = git('rev-parse', 'HEAD').trim()
    git('checkout', '-q', '-b', 'work')
    commit(head)
    before?.(out)
    const src = readFileSync(SCRIPT, 'utf8').split('\n')
    const cut = (from, to) => {
      const a = src.findIndex((l) => l.startsWith(from))
      const b = src.findIndex((l) => l.startsWith(to))
      expect(a >= 0 && b > a, `script section ${from} .. ${to}`).toBe(true)
      return src.slice(a, b).join('\n')
    }
    const prog = [
      'set -u; set -o pipefail',
      `ROOT=${JSON.stringify(repo)}; OUT=${JSON.stringify(out)}; RESULTS=${JSON.stringify(path.join(out, 'res.tsv'))}; BASE_REF=${baseSha}`,
      cut('record()', '# ---------- checks'),
      cut('# ---------- lint-delta', '# ---------- codeql'),
      'check_lint_delta',
      'cat "$RESULTS"',
    ].join('\n')
    const nodeDir = path.dirname(execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim())
    const log = path.join(home, 'eslint.log')
    const r = spawnSync('bash', ['-c', prog], {
      encoding: 'utf8',
      env: { HOME: home, PATH: `${nodeDir}:/usr/bin:/bin`, STUB_LOG: log, npm_config_update_notifier: 'false', npm_config_offline: 'true' },
      timeout: 60000,
    })
    const rows = r.stdout.split('\n').filter((l) => l.startsWith('lint-delta\t'))
    const calls = (() => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } })()
    const [, status, detail] = (rows[0] ?? '').split('\t')
    return { r, rows, status, detail, calls, repo, out, git }
  }
  const tree = (stub, files = ['src/a.ts']) => ({ stub, files })
  const clean = tree({ files: { 'src/a.ts': [0, 2] } })
  const CRASH_LINE = 'TypeError: node.params is not iterable'

  it('eslint exit 2 on HEAD: FAIL, says "lint crashed", names the crash line, the file and the rule', () => {
    const x = lintDelta(clean, tree({ crash: true }))
    expect(x.rows).toHaveLength(1)
    expect(x.status).toBe('FAIL')
    expect(x.detail).toContain('lint crashed (head, exit 2)')
    expect(x.detail).toContain(CRASH_LINE)
    expect(x.detail).toContain('Occurred while linting scripts/x.d.mts:5')
    expect(x.detail).toContain('Rule: "@typescript-eslint/no-unused-vars"')
    expect(x.detail).not.toContain(' at visit') // the stack stays in the log
    // and the run as a whole fails
    const f = format([...PASS, ['lint-delta', 'FAIL', x.detail]])
    expect(f.status).toBe(1)
    expect(lineOf(f.stdout, 'lint-delta')).toMatch(/FAIL\s+lint crashed/)
  }, 90000)

  it('eslint exit 2 on the BASE tree: FAIL "lint crashed (base", even though HEAD lints clean', () => {
    const x = lintDelta(tree({ crash: true }), clean)
    expect(x.status).toBe('FAIL')
    expect(x.detail).toContain('lint crashed (base, exit 2)')
    expect(x.detail).toContain(CRASH_LINE)
  }, 90000)

  it("runs the package's own lint script (what CI's `npm run lint` runs) over the whole tree, on HEAD and on a merge-base tree", () => {
    const x = lintDelta(clean, clean, { lintScript: 'eslint . --max-warnings 7' })
    expect(x.status).toBe('PASS')
    expect(x.calls).toHaveLength(2)
    for (const c of x.calls) {
      expect(c.args.slice(0, 5)).toEqual(['.', '--max-warnings', '7', '--format', 'json'])
      expect(c.args[5]).toBe('--output-file')
    }
    expect(new Set(x.calls.map((c) => c.cwd)).size).toBe(2)
    const ci = readFileSync(path.join(path.dirname(SCRIPT), '..', '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toMatch(/^ {8}run: npm run lint$/m)
  }, 90000)

  it('same counts: PASS +0/+0; the base worktree is removed and HEAD node_modules is still there', () => {
    const x = lintDelta(clean, clean)
    expect(x.status).toBe('PASS')
    expect(x.detail).toBe('errors +0, warnings +0 (npm run lint: 1 files; head 0 err/2 warn, base 0 err/2 warn)')
    expect(x.git('worktree', 'list').trim().split('\n')).toHaveLength(1)
    expect(statSync(path.join(x.repo, 'node_modules/.bin/eslint')).isFile()).toBe(true)
  }, 90000)

  it.each([
    ['one more warning', [0, 3], /^errors \+0, warnings \+1 /],
    ['one new error', [1, 2], /^errors \+1, warnings \+0 /],
  ])('%s is FAIL', (_n, counts, want) => {
    const x = lintDelta(clean, tree({ files: { 'src/a.ts': counts } }))
    expect(x.status).toBe('FAIL')
    expect(x.detail).toMatch(want)
  }, 90000)

  it('a warning in a file the HEAD diff does not touch is counted too (whole tree, not changed files)', () => {
    const files = ['src/a.ts', 'src/untouched.d.mts']
    const x = lintDelta(
      { stub: { files: { 'src/a.ts': [0, 0], 'src/untouched.d.mts': [0, 0] } }, files },
      { stub: { files: { 'src/a.ts': [0, 0], 'src/untouched.d.mts': [0, 1] } }, files },
    )
    expect(x.status).toBe('FAIL')
    expect(x.detail).toMatch(/^errors \+0, warnings \+1 \(npm run lint: 2 files/)
  }, 90000)

  it('deleting a file with warnings does not pay for new ones elsewhere', () => {
    const stub = (a) => ({ files: { 'src/a.ts': [0, a], 'src/gone.ts': [0, 3] } })
    const x = lintDelta({ stub: stub(0), files: ['src/a.ts', 'src/gone.ts'] }, { stub: stub(3), files: ['src/a.ts'] })
    expect(x.status).toBe('FAIL')
    expect(x.detail).toMatch(/^errors \+0, warnings \+3 \(npm run lint: 1 files; head 0 err\/3 warn, base 0 err\/0 warn\)/)
  }, 90000)

  it('`npm run lint` failing on HEAD is FAIL even with a zero delta (CI would be red)', () => {
    const x = lintDelta(clean, tree({ files: { 'src/a.ts': [0, 2] }, exit: 1 }))
    expect(x.status).toBe('FAIL')
    expect(x.detail).toMatch(/^npm run lint fails on HEAD \(exit 1\): errors \+0, warnings \+0 /)
  }, 90000)

  it('a base that fails its own lint without crashing does not fail a HEAD that passes', () => {
    const x = lintDelta(tree({ files: { 'src/a.ts': [1, 2] }, exit: 1 }), clean)
    expect(x.status).toBe('PASS')
  }, 90000)

  it('exit 0 or 1 with no report is "lint crashed", and a report left in the output dir by an earlier run is not read', () => {
    const stale = (out) => writeFileSync(path.join(out, 'lint-head.json'), JSON.stringify([]))
    for (const exit of [0, 1]) {
      const x = lintDelta(clean, tree({ noReport: true, exit }), { before: stale })
      expect(x.status).toBe('FAIL')
      expect(x.detail).toContain(`lint crashed (head, exit ${exit}): no readable report`)
    }
  }, 90000)

  it('no node_modules/.bin/eslint: FAIL "missing tool", never a copy from somewhere else', () => {
    const x = lintDelta(clean, clean, { noEslint: true })
    expect(x.status).toBe('FAIL')
    expect(x.detail).toMatch(/^missing tool: eslint/)
    expect(x.calls).toHaveLength(0)
  }, 90000)
})
