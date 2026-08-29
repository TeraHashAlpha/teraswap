// Drives the shipped checker (scripts/check-color-contrast.mjs) — imports its CIEDE2000 /
// CVD / parser / evaluate functions and spawns the real CLI for the mutation case.
// Does not re-implement the math.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterEach } from 'vitest'
import {
  ciede2000,
  simulateCvd,
  parseStatusColors,
  hexToLinearRgb,
  pairDeltaE2000,
  evaluatePalette,
  runCheck,
  DE2000_FLOOR,
  DEFAULT_BASELINE,
  STATUS_TOKENS,
} from './check-color-contrast.mjs'

const SCRIPT = fileURLToPath(new URL('./check-color-contrast.mjs', import.meta.url))
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), '..')

const SHARMA_LAB_1 = [50.0, 2.6772, -79.7751]
const SHARMA_LAB_2 = [50.0, 0.0, -82.7485]
const SHARMA_DE00 = 2.0425

function cie76(lab1, lab2) {
  return Math.hypot(lab1[0] - lab2[0], lab1[1] - lab2[1], lab1[2] - lab2[2])
}

function tailwindFixture(colors) {
  return [
    "import type { Config } from 'tailwindcss'",
    'const config: Config = {',
    '  theme: {',
    '    extend: {',
    '      colors: {',
    `        success: '${colors.success}',`,
    "        'success-soft': '#E8F5EC',",
    `        warning: '${colors.warning}',`,
    `        danger: '${colors.danger}',`,
    '      },',
    '    },',
    '  },',
    '}',
    'export default config',
    '',
  ].join('\n')
}

const sandboxes = []
function sandboxDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'color-contrast-'))
  sandboxes.push(dir)
  return dir
}

function spawnChecker(args, cwd = REPO_ROOT) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }
  }
}

afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true })
})

describe('ciede2000 (shipped)', () => {
  it('Sharma et al. reference pair yields dE00 = 2.0425 within 1e-4 (CIE76 of the same pair is ~4 and cannot pass)', () => {
    const dE00 = ciede2000(SHARMA_LAB_1, SHARMA_LAB_2)
    expect(Math.abs(dE00 - SHARMA_DE00)).toBeLessThan(1e-4)

    // A dE76 (CIE76 Euclidean Lab) implementation of this pair returns ~4.0 and
    // MUST fail the 2.0425 ± 1e-4 gate — this is the proof we did not ship dE76
    // labelled as dE2000.
    const dE76 = cie76(SHARMA_LAB_1, SHARMA_LAB_2)
    expect(dE76).toBeGreaterThan(3.5)
    expect(Math.abs(dE76 - SHARMA_DE00)).toBeGreaterThan(1e-4)
  })

  it('identical colours yield 0', () => {
    expect(ciede2000([50, 0, 0], [50, 0, 0])).toBe(0)
    expect(ciede2000([0, 0, 0], [0, 0, 0])).toBe(0)
    expect(ciede2000([100, 40, -20], [100, 40, -20])).toBe(0)
  })
})

describe('simulateCvd (shipped Viénot/Brettel/Mollon 1999)', () => {
  it('leaves a neutral grey unchanged under deuteranopia and protanopia', () => {
    const grey = [0.5, 0.5, 0.5]
    for (const type of ['deuteranopia', 'protanopia']) {
      const out = simulateCvd(grey, type)
      expect(out).toHaveLength(3)
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(out[i] - grey[i])).toBeLessThan(1e-5)
      }
    }
  })

  it('leaves equal-energy white unchanged', () => {
    const white = [1, 1, 1]
    for (const type of ['deuteranopia', 'protanopia']) {
      const out = simulateCvd(white, type)
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(out[i] - white[i])).toBeLessThan(1e-5)
      }
    }
  })
})

describe('parseStatusColors (shipped)', () => {
  it('reads success / warning / danger and ignores success-soft', () => {
    const colors = parseStatusColors(
      tailwindFixture({ success: '#4ADE80', warning: '#F59E0B', danger: '#EF4444' }),
    )
    expect(colors).toEqual({
      success: '#4ADE80',
      warning: '#F59E0B',
      danger: '#EF4444',
    })
  })

  it('follows a palette move (does not hard-code the live hex)', () => {
    const colors = parseStatusColors(
      tailwindFixture({ success: '#00C2A8', warning: '#FFD60A', danger: '#EF4444' }),
    )
    expect(colors.success).toBe('#00C2A8')
    expect(colors.warning).toBe('#FFD60A')
  })

  it('fails loudly when a status key is missing', () => {
    expect(() => parseStatusColors('theme: { colors: { warning: \'#F59E0B\', danger: \'#EF4444\' } }')).toThrow(
      /cannot read status colour "success"/,
    )
  })

  it('fails loudly when a key is duplicated', () => {
    const src = tailwindFixture({ success: '#4ADE80', warning: '#F59E0B', danger: '#EF4444' }).replace(
      "danger: '#EF4444',",
      "danger: '#EF4444',\n        danger: '#FF0000',",
    )
    expect(() => parseStatusColors(src)).toThrow(/ambiguous status colour "danger"/)
  })

  it('does not treat a commented-out assignment as the live value', () => {
    const src = [
      "        // success: '#000000',",
      "        success: '#4ADE80',",
      "        warning: '#F59E0B',",
      "        danger: '#EF4444',",
      '',
    ].join('\n')
    expect(parseStatusColors(src).success).toBe('#4ADE80')
  })
})

describe('evaluatePalette anti-rot / mutation', () => {
  it('fails a deliberately colliding unbaselined pair (the assertion bites)', () => {
    const colors = { success: '#00AA00', warning: '#00AA00', danger: '#FF0000' }
    const result = evaluatePalette(colors, [])
    expect(result.ok).toBe(false)
    const colliding = result.failures.filter((r) => r.a === 'success' && r.b === 'warning')
    expect(colliding.length).toBeGreaterThan(0)
    for (const row of colliding) {
      expect(row.status).toBe('FAIL')
      expect(row.delta).toBeLessThan(DE2000_FLOOR)
    }
  })

  it('fails when a baseline entry starts passing (anti-rot)', () => {
    const colors = { success: '#00C2A8', warning: '#FFD60A', danger: '#EF4444' }
    const result = evaluatePalette(colors, ['normal:success/warning'])
    expect(result.ok).toBe(false)
    const rot = result.failures.find((r) => r.key === 'normal:success/warning')
    expect(rot).toBeDefined()
    expect(rot.status).toBe('BASELINE-ROT')
    expect(rot.delta).toBeGreaterThanOrEqual(DE2000_FLOOR)
  })

  it('passes a well-separated unbaselined palette', () => {
    const colors = { success: '#00C2A8', warning: '#FFD60A', danger: '#EF4444' }
    const result = evaluatePalette(colors, [])
    expect(result.ok).toBe(true)
    expect(result.rows.every((r) => r.status === 'pass')).toBe(true)
  })
})

describe('runCheck CLI entry (shipped)', () => {
  it('mutation: spawning the real checker against a colliding fixture exits non-zero', () => {
    const dir = sandboxDir()
    const configPath = path.join(dir, 'tailwind.config.ts')
    writeFileSync(
      configPath,
      tailwindFixture({ success: '#00AA00', warning: '#00AA00', danger: '#FF0000' }),
    )
    const spawned = spawnChecker(['--config', configPath])
    expect(spawned.code).not.toBe(0)
    expect(spawned.stderr).toMatch(/FAIL deuteranopia:success\/warning|FAIL normal:success\/warning/)
    expect(spawned.stdout).toMatch(/success\/warning/)
  })

  it('parser miss via the real entry point exits 2', () => {
    const dir = sandboxDir()
    const configPath = path.join(dir, 'tailwind.config.ts')
    writeFileSync(configPath, 'export default { theme: { extend: { colors: {} } } }\n')
    const spawned = spawnChecker(['--config', configPath])
    expect(spawned.code).toBe(2)
    expect(spawned.stderr).toMatch(/cannot read status colour/)
  })

  it('live tailwind.config.ts is parseable and the known misses are the only under-15 pairs', () => {
    const result = runCheck({ configPath: path.join(REPO_ROOT, 'tailwind.config.ts') })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/success=#[0-9A-F]{6} \(hex_len=7\)/)
    expect(result.stdout).toMatch(/warning=#[0-9A-F]{6} \(hex_len=7\)/)
    expect(result.stdout).toMatch(/danger=#[0-9A-F]{6} \(hex_len=7\)/)
    for (const key of DEFAULT_BASELINE) {
      const [condition, pair] = key.split(':')
      expect(result.stdout).toMatch(new RegExp(`${condition}\\s+${pair}\\s+\\d+\\.\\d+\\s+baselined`))
    }
    expect(result.stdout).toMatch(/FAIL=0/)
    expect(result.stdout).toMatch(/BASELINE-ROT=0/)
    expect(result.stdout).toMatch(new RegExp(`baselined=${DEFAULT_BASELINE.length}`))
  })
})

describe('pairDeltaE2000 identity', () => {
  it('a colour compared with itself is 0 under every condition', () => {
    for (const hex of ['#4ADE80', '#808080', '#000000', '#FFFFFF']) {
      for (const condition of ['normal', 'deuteranopia', 'protanopia']) {
        expect(pairDeltaE2000(hex, hex, condition)).toBe(0)
      }
    }
  })

  it('hexToLinearRgb rejects non-hex', () => {
    expect(() => hexToLinearRgb('#GGG')).toThrow(/invalid hex/)
    expect(() => hexToLinearRgb('#4ADE8')).toThrow(/invalid hex/)
  })

  it('STATUS_TOKENS are the three status keys', () => {
    expect(STATUS_TOKENS).toEqual(['success', 'warning', 'danger'])
  })
})
