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
const WORKTREE_ROOT = path.resolve(path.dirname(SCRIPT), '..')

// grok-dispatch.sh guards GROK_WORKTREE_BASE_DIR against MAIN_ROOT — the FIRST entry of
// `git worktree list`, i.e. the main checkout — not wherever this test file happens to live.
// Worktrees now live outside the repo (~/ts-worktrees/), so deriving REPO_ROOT from the test's
// own file location (this worktree's root) probed the wrong directory: it never matched
// MAIN_ROOT, so both negative controls below silently never fired, from any worktree. Derive it
// the same way the script does so the controls test the guard, not the test's own location.
const MAIN_ROOT_LINE = execFileSync('git', ['worktree', 'list', '--porcelain'], {
  cwd: WORKTREE_ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .find((line) => line.startsWith('worktree '))
const REPO_ROOT = MAIN_ROOT_LINE.slice('worktree '.length)

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

function run(args, env) {
  try {
    const stdout = execFileSync(SCRIPT, args, {
      cwd: WORKTREE_ROOT,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
    })
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

describe('grok-dispatch.sh — FIX-GROK-GUARD-CLAIMS: worktree lives outside the repo', () => {
  // The .env*/keychain --deny flags are speed bumps, not enforcement (measured, see
  // docs/security/GROK-DENY-CANARY-2026-08-28.md). The REAL control is that Grok never runs
  // anywhere near this repo's real, untracked .env* files — a worktree outside the repo entirely
  // has no such files to reach, tracked-only or otherwise.
  function extractWorktreePath(stdout) {
    const match = stdout.match(/^worktree:\s+(\S.*?)\s+\(git worktree add/m)
    return match?.[1]
  }

  it('the default worktree base dir resolves outside the repo (positive control)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const branch = uniqueBranch('worktree-outside')
    const result = run([spec, branch, '--dry-run'])
    const worktreePath = extractWorktreePath(result.stdout)

    expect(worktreePath).toBeTruthy()
    expect(worktreePath.startsWith(REPO_ROOT)).toBe(false)
    expect(worktreePath).toContain(branch)
    // Never the old in-repo location.
    expect(worktreePath).not.toContain('.claude/worktrees')
  })

  it('a base dir under the repo root is rejected outright, in --dry-run too (negative control)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const branch = uniqueBranch('worktree-rejected')
    // REPO_ROOT is the main checkout itself (matching the script's own MAIN_ROOT derivation), so
    // it's a valid "inside the repo" probe regardless of which worktree this test suite happens
    // to run from.
    const insideRepoBase = path.join(REPO_ROOT, 'scratch-worktree-base')
    const result = run([spec, branch, '--dry-run'], { TS_WORKTREE_BASE: insideRepoBase })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Refusing')
    expect(result.stderr).toContain('is inside the repo')
    expect(result.stderr).toContain(insideRepoBase)
    // The refusal must fire before anything resembling the plan report — no worktree line at all.
    expect(result.stdout).not.toContain('worktree:')
  })

  it('a base dir equal to the repo root itself is also rejected (negative control, boundary case)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const branch = uniqueBranch('worktree-rejected-exact')
    const result = run([spec, branch, '--dry-run'], { TS_WORKTREE_BASE: REPO_ROOT })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Refusing')
  })

  it('TS_WORKTREE_BASE outside the repo is honored and reflected in the plan (positive control)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const branch = uniqueBranch('worktree-custom-base')
    const customBase = mkdtempSync(path.join(tmpdir(), 'grok-worktree-base-'))
    specDirs.push(customBase)
    const result = run([spec, branch, '--dry-run'], { TS_WORKTREE_BASE: customBase })
    const worktreePath = extractWorktreePath(result.stdout)

    expect(result.code).toBe(0)
    expect(worktreePath.startsWith(customBase)).toBe(true)
  })
})

describe('grok-dispatch.sh — CHORE-GROK-DENY-FLAGS: deny flags on every invocation', () => {
  // Verified against `grok --help` / ~/.grok/README.md's Permission Rules section — see the
  // GROK_DENY_FLAGS comment in grok-dispatch.sh. Kept here as plain substrings, not a shared
  // import, so this test independently re-states what the shipped command must contain.
  const EXPECTED_DENY_FLAGS = [
    '--deny Read(.env*)',
    '--deny Read(**/.env*)',
    '--deny Bash(security*)',
    '--deny Bash(git credential-*)',
  ]

  // printf '%q' backslash-escapes the parens/asterisks/space in the reported command; strip
  // backslashes so we can assert on the plain ToolPrefix(glob) text.
  function unescapedCommand(stdout) {
    const commandBlock = stdout.split('-- exact command')[1] ?? ''
    return commandBlock.replace(/\\/g, '')
  }

  it('every deny flag appears in the --dry-run command (positive control)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const result = run([spec, uniqueBranch('denyflags'), '--dry-run'])
    const command = unescapedCommand(result.stdout)
    for (const flag of EXPECTED_DENY_FLAGS) {
      expect(command).toContain(flag)
    }
  })

  it('every deny flag appears regardless of approval mode (interactive path too)', () => {
    const spec = specFile('spec.md', specWithFiles(CONTROL_HIGH, ['src/foo.ts']))
    const result = run([spec, uniqueBranch('denyflags-interactive'), '--dry-run'])
    const command = unescapedCommand(result.stdout)
    for (const flag of EXPECTED_DENY_FLAGS) {
      expect(command).toContain(flag)
    }
  })

  it('a copy of the script with one deny flag dropped fails this assertion (negative control — proves it bites)', () => {
    // Mutate a scratch copy of the real script, not the array literal in this test file — the
    // point is to prove the ACTUAL dispatcher's command-building breaks the assertion above if a
    // flag is ever dropped, not just that our own expectation list can shrink.
    const mutatedDir = mkdtempSync(path.join(tmpdir(), 'grok-dispatch-mutant-'))
    specDirs.push(mutatedDir)
    const mutatedScript = path.join(mutatedDir, 'grok-dispatch.sh')
    const original = execFileSync('cat', [SCRIPT], { encoding: 'utf8' })
    const mutated = original.replace('  --deny "Bash(security*)"\n', '')
    expect(mutated).not.toBe(original) // sanity: the replace actually matched something
    writeFileSync(mutatedScript, mutated, { mode: 0o755 })

    const spec = specFile('spec.md', specWithFiles(CONTROL_MEDIUM, ['src/foo.ts']))
    const result = (() => {
      try {
        const stdout = execFileSync(mutatedScript, [spec, uniqueBranch('mutant'), '--dry-run'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        })
        return { stdout }
      } catch (err) {
        return { stdout: err.stdout ?? '' }
      }
    })()
    const command = unescapedCommand(result.stdout)

    expect(command).toContain('--deny Read(.env*)') // the other flags are still there
    expect(command).not.toContain('--deny Bash(security*)') // the dropped one is gone

    // Prove the positive-control assertion style would have FAILED against this mutant, i.e.
    // requirement 4's "builder mutated to drop a flag FAILS the test" is demonstrated, not
    // asserted.
    const wouldPass = EXPECTED_DENY_FLAGS.every((flag) => command.includes(flag))
    expect(wouldPass).toBe(false)
  })
})
