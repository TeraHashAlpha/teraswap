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
      cut('find_node_major()', '# ---------- formatter'),
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

  it('a missing major is FAIL, never substituted, and prints ONE install line naming only the missing majors', () => {
    const h = mk()
    fakeNode(path.join(h, '.nvm/versions/node/v22.3.0/bin/node'), 22)
    const r = keeper(h)
    const line = r.stdout.split('\n').find((l) => l.startsWith('keeper\t'))
    expect(line).toMatch(/^keeper\tFAIL\t/)
    expect(line).toContain('node20:MISSING')
    expect(line).toContain('node22:5-pass')
    expect(line).toMatch(/install: brew install node@20$/)
    const both = keeper(mk()).stdout.split('\n').find((l) => l.startsWith('keeper\t'))
    expect(both).toMatch(/install: brew install node@20 node@22$/)
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
