// Exercises scripts/grok-dispatch.sh as a subprocess. Every test here either uses --dry-run
// (which the script guarantees never invokes the `grok` binary) or an --execute run against a
// spec that fails validation before the grok-invocation line is reached — this suite MUST NEVER
// exercise a passing --execute path, since that would actually shell out to `grok` and hit the
// xAI API, which is explicitly out of scope for this change.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterEach } from 'vitest'

const SCRIPT = fileURLToPath(new URL('./grok-dispatch.sh', import.meta.url))
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), '..')

const specDirs = []
function specFile(name, content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'grok-dispatch-spec-'))
  specDirs.push(dir)
  const file = path.join(dir, name)
  writeFileSync(file, content)
  return file
}

function uniqueBranch(tag) {
  return `chore/test-${tag}-${Math.random().toString(36).slice(2, 8)}`
}

function run(args) {
  try {
    const stdout = execFileSync(SCRIPT, args, { cwd: REPO_ROOT, encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

const CONTROL_MEDIUM = 'CONTROL: model Sonnet · effort medium · NO CI-poll · read ONLY <src/foo.ts>.'
const CONTROL_LOW = 'CONTROL: model Haiku · effort low · NO CI-poll · read ONLY <src/foo.ts>.'
const CONTROL_HIGH = 'CONTROL: model Opus · effort high · NO CI-poll · read ONLY <src/foo.ts>.'

function specWithFiles(control, files) {
  return [control, '', '## Files affected (read ONLY these)', ...files.map((f) => `- ${f}`), ''].join('\n')
}

afterEach(() => {
  while (specDirs.length) rmSync(specDirs.pop(), { recursive: true, force: true })
  // Defensive: fail loudly if any test accidentally left a worktree behind — that would mean
  // a refusal path did not actually stop before `git worktree add`.
  const stray = path.join(REPO_ROOT, '.claude', 'worktrees')
  if (existsSync(stray)) {
    const leftover = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(leftover).not.toMatch(/test-/)
  }
})

describe('grok-dispatch.sh — argument handling', () => {
  it('refuses with usage when spec or branch is missing', () => {
    const result = run(['/nonexistent/spec.md'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })

  it('refuses when the spec file does not exist', () => {
    const result = run(['/nonexistent/spec.md', uniqueBranch('nofile'), '--dry-run'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('spec file not found')
  })

  it('defaults to dry-run with no flags (positive control: never invokes grok)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const result = run([spec, uniqueBranch('default')])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('mode:              dry-run')
    expect(result.stdout).toContain('grok not invoked')
  })

  it('an explicit --dry-run alongside --execute stays dry-run (negative control on --execute)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const result = run([spec, uniqueBranch('both-flags'), '--execute', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('mode:              dry-run')
    expect(result.stdout).toContain('grok not invoked')
  })
})

describe('grok-dispatch.sh — CONTROL header gate', () => {
  it('refuses (dry-run reports REFUSE, exit 0) when no CONTROL line exists', () => {
    const spec = specFile('spec.md', specWithFiles('No control header here.', ['src/foo.ts']))
    const result = run([spec, uniqueBranch('nocontrol'), '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("[REFUSE] CONTROL header invalid: no line starting with 'CONTROL:'")
  })

  it('refuses outright in --execute mode when no CONTROL line exists (hard refusal, never reaches grok)', () => {
    const spec = specFile('spec.md', specWithFiles('No control header here.', ['src/foo.ts']))
    const result = run([spec, uniqueBranch('nocontrol-exec'), '--execute'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Refusing')
  })

  it('accepts a well-formed CONTROL line (positive control)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const result = run([spec, uniqueBranch('goodcontrol'), '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[ok]     CONTROL header present, effort=medium')
  })

  it('refuses a CONTROL line missing the effort field (negative control)', () => {
    const spec = specFile(
      'spec.md',
      specWithFiles('CONTROL: model Sonnet · NO CI-poll · read ONLY <src/foo.ts>.', ['src/foo.ts'])
    )
    const result = run([spec, uniqueBranch('noeffort'), '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("missing an explicit 'effort")
  })
})

describe('grok-dispatch.sh — model resolution table', () => {
  it.each([
    [CONTROL_LOW, 'grok-build-0.1'],
    [CONTROL_MEDIUM, 'grok-4.5'],
    [CONTROL_HIGH, 'grok-4.6'],
  ])('resolves %s effort to %s', (control, expectedModel) => {
    const spec = specFile('spec.md', specWithFiles(control, ['src/foo.ts']))
    const result = run([spec, uniqueBranch('model'), '--dry-run'])
    expect(result.stdout).toContain(`resolved model:    ${expectedModel}`)
  })
})

describe('grok-dispatch.sh — .env* / keychain refusal', () => {
  it('refuses (dry-run reports REFUSE) when Files affected lists a .env path', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['.env.local']))
    const result = run([spec, uniqueBranch('env'), '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[REFUSE] Files affected references .env*')
  })

  it('refuses outright in --execute mode for a .env path (hard refusal, never reaches grok)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['.env.production']))
    const result = run([spec, uniqueBranch('env-exec'), '--execute'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('never dispatched')
  })

  it('refuses on a keychain reference', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['scripts uses macOS keychain lookup']))
    const result = run([spec, uniqueBranch('keychain'), '--dry-run'])
    expect(result.stdout).toContain('[REFUSE] Files affected references .env* or a keychain')
  })

  it('does not refuse a normal file list (negative control)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/components/Foo.tsx']))
    const result = run([spec, uniqueBranch('cleanfiles'), '--dry-run'])
    expect(result.stdout).toContain('[ok]     no .env*/keychain reference')
  })
})

describe('grok-dispatch.sh — fund-flow-adjacent paths force interactive mode', () => {
  it.each([
    ['contracts/order-engine/Foo.sol', 'contracts/*'],
    ['keeper/executor.js', 'keeper/*'],
    ['src/lib/order-executor.ts', '*executor*'],
    ['src/lib/chains/registry.ts', 'src/lib/chains/*'],
    ['src/lib/useSwapQuote.ts', '*swap*'],
    ['src/lib/oracleGate.ts', '*gate*'],
    ['src/lib/keeperSigner.ts', '*signer*'],
  ])('matches %s against pattern %s and forces interactive mode', (file) => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, [file]))
    const result = run([spec, uniqueBranch('sensitive'), '--dry-run'])
    expect(result.stdout).toContain('[interactive-only] Files affected matches a fund-flow-adjacent path')
    expect(result.stdout).toContain('approval mode:     interactive (no --always-approve)')
  })

  it('does not force interactive mode for an unrelated frontend file (negative control)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/components/Badge.tsx']))
    const result = run([spec, uniqueBranch('notsensitive'), '--dry-run'])
    expect(result.stdout).toContain('[ok]     no fund-flow-adjacent path in Files affected')
    expect(result.stdout).toContain('approval mode:     --always-approve')
  })
})

describe('grok-dispatch.sh — high effort tier forces interactive mode', () => {
  it('forces interactive mode when effort is high (positive control)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_HIGH, ['src/foo.ts']))
    const result = run([spec, uniqueBranch('hightier'), '--dry-run'])
    expect(result.stdout).toContain('[interactive-only] effort tier is high')
    expect(result.stdout).toContain('approval mode:     interactive (no --always-approve)')
  })

  it('does not force interactive mode for medium effort (negative control)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const result = run([spec, uniqueBranch('medtier'), '--dry-run'])
    expect(result.stdout).toContain('[ok]     effort tier is not high')
  })
})

describe('grok-dispatch.sh — worktree targeting', () => {
  it('always resolves the worktree under the main checkout, never the checkout itself', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const branch = uniqueBranch('worktree')
    const result = run([spec, branch, '--dry-run'])
    expect(result.stdout).toMatch(/worktree:\s+\S.*\.claude\/worktrees\//)
    expect(result.stdout).toContain(branch)
  })
})
