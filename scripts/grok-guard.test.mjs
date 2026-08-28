// Sources scripts/grok-guard.sh from real bash and zsh subshells (bash and zsh are the two
// shells it must work under per the spec — zsh is the repo owner's macOS default) against a
// stub `grok` on PATH, so the assertions are on actual shell behavior, not string inspection of
// the script. Never touches the real `grok` binary or the network.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const GUARD_SCRIPT = fileURLToPath(new URL('./grok-guard.sh', import.meta.url))
const REPO_ROOT = path.resolve(path.dirname(GUARD_SCRIPT), '..')

let stubDir
beforeAll(() => {
  stubDir = mkdtempSync(path.join(tmpdir(), 'grok-guard-stub-'))
  const stub = path.join(stubDir, 'grok')
  writeFileSync(stub, '#!/usr/bin/env bash\necho "STUB grok called with args: $*"\n')
  chmodSync(stub, 0o755)
})
afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true })
})

function runInShell(shell, extraArgs) {
  const script = `PATH="${stubDir}:$PATH"; source "${GUARD_SCRIPT}"; grok ${extraArgs}`
  return execFileSync(shell, ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' })
}

const EXPECTED_DENY_FLAGS = [
  '--deny Read(.env*)',
  '--deny Read(**/.env*)',
  '--deny Bash(security*)',
  '--deny Bash(git credential-*)',
]

describe.each([
  ['bash', 'bash'],
  ['zsh', 'zsh'],
])('grok-guard.sh sourced from %s', (_label, shell) => {
  it('injects every deny flag ahead of the caller-supplied args (positive control)', () => {
    const output = runInShell(shell, '-p "hello" --output-format json')
    for (const flag of EXPECTED_DENY_FLAGS) {
      expect(output).toContain(flag)
    }
    expect(output).toContain('-p hello --output-format json')
  })

  it('passes through arbitrary caller args unmodified (positive control)', () => {
    const output = runInShell(shell, '--model grok-4.6 --worktree feat')
    expect(output).toContain('--model grok-4.6 --worktree feat')
  })

  it('a stub with one flag removed would fail the flag-list assertion (negative control — proves it bites)', () => {
    // Sources a hand-mutated inline function (not the real file) to prove the assertion style
    // above actually depends on each flag being present, mirroring the dispatcher's mutation test.
    const mutatedFn = [
      'grok() {',
      '  command grok \\',
      '    --deny "Read(.env*)" \\',
      '    --deny "Read(**/.env*)" \\',
      '    --deny "Bash(git credential-*)" \\', // Bash(security*) deliberately dropped
      '    "$@"',
      '}',
    ].join('\n')
    const script = `PATH="${stubDir}:$PATH"; ${mutatedFn}; grok -p "hello"`
    const output = execFileSync(shell, ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8' })

    expect(output).toContain('--deny Read(.env*)')
    expect(output).not.toContain('--deny Bash(security*)')

    const wouldPass = EXPECTED_DENY_FLAGS.every((flag) => output.includes(flag))
    expect(wouldPass).toBe(false)
  })
})

describe('grok-guard.sh — tracking', () => {
  it('is a real file that exists on disk (sanity before the git-tracking proof in feedback)', () => {
    expect(existsSync(GUARD_SCRIPT)).toBe(true)
  })
})
