// Runs the real script as a subprocess against a scratch copy of CLAUDE.md/AGENTS.md so drift
// detection and --write are exercised end-to-end, not just their string logic in isolation.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'

const SCRIPT_SRC = fileURLToPath(new URL('./check-agents-parity.mjs', import.meta.url))

function makeSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'agents-parity-'))
  mkdirSync(path.join(root, 'scripts'))
  copyFileSync(SCRIPT_SRC, path.join(root, 'scripts', 'check-agents-parity.mjs'))
  return root
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function run(root, args = []) {
  try {
    const stdout = execFileSync('node', ['scripts/check-agents-parity.mjs', ...args], {
      cwd: root,
      encoding: 'utf8',
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

const sandboxes = []
afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true })
})

describe('check-agents-parity', () => {
  it('passes when the pinned hash matches CLAUDE.md (positive control)', () => {
    const root = makeSandbox()
    sandboxes.push(root)
    const claude = '# CLAUDE.md fixture\nsome rule\n'
    writeFileSync(path.join(root, 'CLAUDE.md'), claude)
    const hash = sha256(claude)
    writeFileSync(path.join(root, 'AGENTS.md'), `<!-- claude-md-sha256: ${hash} -->\n# AGENTS.md fixture\n`)

    const result = run(root)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('parity OK')
    expect(result.stdout).toContain(`len=${hash.length}`)
  })

  it('fails when CLAUDE.md changed since the pin (negative control)', () => {
    const root = makeSandbox()
    sandboxes.push(root)
    const originalClaude = '# CLAUDE.md fixture\nsome rule\n'
    const staleHash = sha256(originalClaude)
    writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md fixture\nsome rule CHANGED\n')
    writeFileSync(path.join(root, 'AGENTS.md'), `<!-- claude-md-sha256: ${staleHash} -->\n# AGENTS.md fixture\n`)

    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('out of sync')
    expect(result.stderr).toContain(`expected`)
    expect(result.stderr).toContain(`actual`)
    expect(result.stderr).toContain('len=64')
  })

  it('rejects an AGENTS.md missing the sha256 comment line', () => {
    const root = makeSandbox()
    sandboxes.push(root)
    writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md fixture\n')
    writeFileSync(path.join(root, 'AGENTS.md'), '# AGENTS.md fixture with no pin\n')

    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('must start with')
  })

  it('--write regenerates the pin so a subsequent check passes (round trip)', () => {
    const root = makeSandbox()
    sandboxes.push(root)
    const claude = '# CLAUDE.md fixture\nanother rule\n'
    writeFileSync(path.join(root, 'CLAUDE.md'), claude)
    writeFileSync(path.join(root, 'AGENTS.md'), '<!-- claude-md-sha256: PENDING -->\n# AGENTS.md fixture\n')

    const writeResult = run(root, ['--write'])
    expect(writeResult.code).toBe(0)

    const updated = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
    expect(updated).toContain(sha256(claude))

    const checkResult = run(root)
    expect(checkResult.code).toBe(0)
  })
})
