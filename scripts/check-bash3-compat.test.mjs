// The script under test shells out to `git ls-files '*.sh'`, so these tests run it against a
// scratch git repo (not this repo's real tree) to control exactly which .sh files exist, plus a
// direct run against this repo's real scripts/grok-dispatch.sh as a required positive control.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterEach } from 'vitest'

const SCRIPT_SRC = fileURLToPath(new URL('./check-bash3-compat.mjs', import.meta.url))
const GROK_DISPATCH_SRC = fileURLToPath(new URL('./grok-dispatch.sh', import.meta.url))
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_SRC), '..')

const sandboxes = []
function makeSandboxRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'bash3-compat-'))
  sandboxes.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  mkdirSync(path.join(root, 'scripts'))
  copyFileSync(SCRIPT_SRC, path.join(root, 'scripts', 'check-bash3-compat.mjs'))
  return root
}

function addShFile(root, name, content) {
  const file = path.join(root, name)
  writeFileSync(file, content)
  execFileSync('git', ['add', name], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', name], { cwd: root })
}

function run(root) {
  try {
    const stdout = execFileSync('node', ['scripts/check-bash3-compat.mjs'], { cwd: root, encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true })
})

describe('check-bash3-compat', () => {
  it('passes a repo with no .sh files', () => {
    const root = makeSandboxRepo()
    const result = run(root)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('0 tracked .sh file(s)')
  })

  it('fails on ${var,,} used in CODE (positive control)', () => {
    const root = makeSandboxRepo()
    addShFile(root, 'bad.sh', '#!/usr/bin/env bash\nx="Foo"\necho "${x,,}"\n')
    const result = run(root)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('bad.sh:3')
    expect(result.stderr).toContain('bash4 case conversion')
  })

  it('passes when ${var,,} only appears in a COMMENT (required false-positive regression test)', () => {
    const root = makeSandboxRepo()
    addShFile(
      root,
      'ok.sh',
      [
        '#!/usr/bin/env bash',
        "# tr, not bash4-only \${var,,}, to stay compatible with macOS's stock bash 3.2.",
        'line_lower="$(printf \'%s\' "$line" | tr \'[:upper:]\' \'[:lower:]\')"',
        '',
      ].join('\n')
    )
    const result = run(root)
    expect(result.code).toBe(0)
  })

  it('fails on declare -A (positive control)', () => {
    const root = makeSandboxRepo()
    addShFile(root, 'assoc.sh', '#!/usr/bin/env bash\ndeclare -A TABLE\nTABLE[low]="x"\n')
    const result = run(root)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('assoc.sh:2')
    expect(result.stderr).toContain('associative array')
  })

  it('fails on mapfile (positive control)', () => {
    const root = makeSandboxRepo()
    addShFile(root, 'mf.sh', '#!/usr/bin/env bash\nmapfile -t lines < file.txt\n')
    const result = run(root)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('mapfile')
  })

  it('fails on readarray (positive control)', () => {
    const root = makeSandboxRepo()
    addShFile(root, 'ra.sh', '#!/usr/bin/env bash\nreadarray -t lines < file.txt\n')
    const result = run(root)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('readarray')
  })

  it('fails on shopt -s globstar (positive control)', () => {
    const root = makeSandboxRepo()
    addShFile(root, 'gs.sh', '#!/usr/bin/env bash\nshopt -s globstar\necho **/*.ts\n')
    const result = run(root)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('globstar')
  })

  it('passes a script using only bash 3.2-safe constructs (negative control)', () => {
    const root = makeSandboxRepo()
    addShFile(
      root,
      'clean.sh',
      ['#!/usr/bin/env bash', 'set -euo pipefail', 'x="Foo"', 'echo "$(printf \'%s\' "$x" | tr \'[:upper:]\' \'[:lower:]\')"', ''].join(
        '\n'
      )
    )
    const result = run(root)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('1 tracked .sh file(s), 0 violations')
  })

  it('reports every violation, not just the first, across multiple files', () => {
    const root = makeSandboxRepo()
    addShFile(root, 'a.sh', '#!/usr/bin/env bash\necho "${x,,}"\n')
    addShFile(root, 'b.sh', '#!/usr/bin/env bash\ndeclare -A T\n')
    const result = run(root)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('a.sh:2')
    expect(result.stderr).toContain('b.sh:2')
  })
})

describe('check-bash3-compat — required test case from grok-dispatch.sh', () => {
  it('the real scripts/grok-dispatch.sh passes (it has a comment mentioning ${var,,})', () => {
    const source = readFileSync(GROK_DISPATCH_SRC, 'utf8')
    expect(source).toMatch(/#.*\$\{var,,\}/)

    const root = makeSandboxRepo()
    copyFileSync(GROK_DISPATCH_SRC, path.join(root, 'grok-dispatch.sh'))
    execFileSync('git', ['add', 'grok-dispatch.sh'], { cwd: root })
    execFileSync('git', ['commit', '-q', '-m', 'grok-dispatch.sh'], { cwd: root })

    const result = run(root)
    expect(result.code).toBe(0)
  })

  it('the real scripts/grok-dispatch.sh passes when checked in place in this repo', () => {
    const result = (() => {
      try {
        const stdout = execFileSync('node', ['scripts/check-bash3-compat.mjs'], { cwd: REPO_ROOT, encoding: 'utf8' })
        return { code: 0, stdout }
      } catch (err) {
        return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
      }
    })()
    expect(result.code).toBe(0)
  })
})
