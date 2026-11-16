// Runs the real script as a subprocess against a scratch copy of CLAUDE.md/AGENTS.md so drift
// detection and --write are exercised end-to-end, not just their string logic in isolation.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { BEGIN, END } from './gen-claude-state.mjs'

const SCRIPT_SRC = fileURLToPath(new URL('./check-agents-parity.mjs', import.meta.url))

const sandboxes = []
afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true })
})

function makeSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'agents-parity-'))
  mkdirSync(path.join(root, 'scripts'))
  copyFileSync(SCRIPT_SRC, path.join(root, 'scripts', 'check-agents-parity.mjs'))
  sandboxes.push(root)
  return root
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// A CLAUDE.md fixture: hand-written rules around a generated block, like the real file.
const claudeWith = ({ rule = 'some rule', block = 'generated line 1' } = {}) =>
  `# CLAUDE.md fixture\n${rule}\n${BEGIN}\n${block}\n${END}\nmore rules\n`
// The pin is the sha256 of CLAUDE.md with BEGIN..END (markers included) cut out.
const pinFor = (content) => sha256(content.slice(0, content.indexOf(BEGIN)) + content.slice(content.indexOf(END) + END.length))

function setup(claude, pin) {
  const root = makeSandbox()
  writeFileSync(path.join(root, 'CLAUDE.md'), claude)
  writeFileSync(path.join(root, 'AGENTS.md'), `<!-- claude-md-sha256: ${pin} -->\n# AGENTS.md fixture\n`)
  return root
}

function run(root, args = []) {
  try {
    const stdout = execFileSync('node', ['scripts/check-agents-parity.mjs', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('check-agents-parity', () => {
  it('passes when the pinned hash matches CLAUDE.md (positive control)', () => {
    const claude = claudeWith()
    const hash = pinFor(claude)
    const result = run(setup(claude, hash))

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('parity OK')
    expect(result.stdout).toContain(`len=${hash.length}`)
  })

  it('fails when CLAUDE.md changed since the pin (negative control)', () => {
    const staleHash = pinFor(claudeWith())
    const result = run(setup(claudeWith({ rule: 'some rule CHANGED' }), staleHash))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('out of sync')
    expect(result.stderr).toContain(`expected`)
    expect(result.stderr).toContain(`actual`)
    expect(result.stderr).toContain('len=64')
  })

  it('rejects an AGENTS.md missing the sha256 comment line', () => {
    const root = setup(claudeWith(), 'PENDING')
    writeFileSync(path.join(root, 'AGENTS.md'), '# AGENTS.md fixture with no pin\n')

    const result = run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('must start with')
  })

  it('--write regenerates the pin so a subsequent check passes (round trip)', () => {
    const claude = claudeWith({ rule: 'another rule' })
    const root = setup(claude, 'PENDING')

    const writeResult = run(root, ['--write'])
    expect(writeResult.code).toBe(0)

    const updated = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
    expect(updated).toContain(pinFor(claude))

    const checkResult = run(root)
    expect(checkResult.code).toBe(0)
  })
})

describe('check-agents-parity: the generated state block is not part of the pin', () => {
  it('changing a rule OUTSIDE the block fails (before and after the block)', () => {
    const pinned = pinFor(claudeWith())
    for (const changed of [claudeWith({ rule: 'a different rule' }), claudeWith().replace('more rules', 'more rules, edited')]) {
      const r = run(setup(changed, pinned))
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('out of sync')
    }
  })

  it('regenerating the block with different content does NOT change the pin', () => {
    const pinned = pinFor(claudeWith())
    const regenerated = claudeWith({ block: 'a new ADR row\na new workflow row\n| FeeCollector | Arbitrum | 0xabc |' })
    expect(regenerated).not.toBe(claudeWith())
    const r = run(setup(regenerated, pinned))
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('parity OK')
  })

  it('an empty block still passes, and the markers themselves are excluded from the hash', () => {
    const pinned = pinFor(claudeWith())
    expect(run(setup(claudeWith({ block: '' }), pinned)).code).toBe(0)
    // the pin is the hash of the file with the whole BEGIN..END span removed, nothing else
    expect(pinned).toBe(sha256('# CLAUDE.md fixture\nsome rule\n\nmore rules\n'))
  })

  const bad = {
    'missing begin marker': claudeWith().replace(BEGIN, ''),
    'missing end marker': claudeWith().replace(END, ''),
    'both markers missing': claudeWith().replace(BEGIN, '').replace(END, ''),
    'duplicated begin marker': claudeWith().replace(BEGIN, `${BEGIN}\n${BEGIN}`),
    'duplicated end marker': claudeWith().replace(END, `${END}\n${END}`),
    'duplicated block': claudeWith() + claudeWith({ rule: 'x' }),
    'reversed markers': `# CLAUDE.md fixture\nsome rule\n${END}\nstuff\n${BEGIN}\nmore rules\n`,
  }
  for (const [name, claude] of Object.entries(bad)) {
    it(`${name} fails loudly in check and in --write, and --write leaves AGENTS.md untouched`, () => {
      const root = setup(claude, 'PENDING')
      const before = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
      for (const args of [[], ['--write']]) {
        const r = run(root, args)
        expect(r.code, args.join(' ')).toBe(1)
        expect(r.stderr).toMatch(/state:begin|state:end|markers/)
        expect(r.stdout).not.toContain('parity OK')
      }
      expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(before)
    })
  }

  it('uses exactly the markers gen-claude-state.mjs writes', () => {
    const src = readFileSync(SCRIPT_SRC, 'utf8')
    expect(src).toContain(`const STATE_BEGIN = '${BEGIN}'`)
    expect(src).toContain(`const STATE_END = '${END}'`)
  })

  it('dry run on the real CLAUDE.md: pin it, regenerate the block with other content, the pin holds; a rule edit does not', () => {
    const real = readFileSync(fileURLToPath(new URL('../CLAUDE.md', import.meta.url)), 'utf8')
    const root = setup(real, 'PENDING')
    expect(run(root, ['--write']).code).toBe(0)
    const pinnedAgents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
    const b = real.indexOf(BEGIN)
    const e = real.indexOf(END) + END.length
    writeFileSync(path.join(root, 'CLAUDE.md'), real.slice(0, b) + `${BEGIN}\n| new | row |\n${END}` + real.slice(e))
    expect(run(root).code).toBe(0)
    expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(pinnedAgents)
    expect(real).toContain('NEVER hardcode secrets')
    writeFileSync(path.join(root, 'CLAUDE.md'), real.replace('NEVER hardcode secrets', 'NEVER hardcode secrets (edited)'))
    expect(run(root).code).toBe(1)
  })
})
