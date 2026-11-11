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
    expect(r.stdout).toMatch(/^compare: (https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/compare\/main\.\.\.\S+|unavailable.*)$/m)
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
