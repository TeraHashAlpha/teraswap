/**
 * [feat/retire-force-mev C3] The daily health report names every source answering HTTP 429:
 * `[SOURCE] <id>: rate-limited (429) since <first seen>` — a ⚠️ row, a Requires-Attention bullet, WARNING.
 *
 * Runs the workflow's OWN scripts, extracted verbatim from .github/workflows/daily-health-report.yml (same harness as
 * daily-health-report-keepers.test.ts): the monitor step's `rate_limited=` token builder and the compose step's report
 * script. Fixtures only — no network, no secrets.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const YML = readFileSync(resolve(process.cwd(), '.github/workflows/daily-health-report.yml'), 'utf-8')
const dir = mkdtempSync(join(tmpdir(), 'daily-report-ratelimit-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function tokenScript(): string {
  const m = YML.match(/rate_limited=\$\(node -e '([^']+)' "\$status_body"\)/)
  if (!m) throw new Error('rate_limited= token builder not found in daily-health-report.yml')
  return m[1]
}
const tokens = (body: unknown): string =>
  execFileSync(process.execPath, ['-e', tokenScript(), typeof body === 'string' ? body : JSON.stringify(body)], { encoding: 'utf-8' })

function composeScript(): string {
  const open = "cat > /tmp/compose-report.mjs <<'NODE_EOF'\n"
  const start = YML.indexOf(open)
  const end = YML.indexOf('\n          NODE_EOF', start)
  if (start < 0 || end < 0) throw new Error('compose-report.mjs heredoc not found in daily-health-report.yml')
  return YML.slice(start + open.length, end).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n')
}

function report(rateLimited: string): string {
  const script = join(dir, 'compose-report.mjs')
  const out = join(dir, `report-${rateLimited.replace(/[^a-z0-9]/gi, '_') || 'none'}.md`)
  writeFileSync(script, composeScript())
  execFileSync(process.execPath, [script], {
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH,
      OUT_PATH: out,
      REPORT_DATE: '2026-11-06',
      SITE_CODE: '200',
      SITE_TIME: '0.2',
      API_CODE: '200',
      API_TIME: '0.2',
      SSL_END: 'Jan  1 00:00:00 2027 GMT',
      SSL_DAYS: '60',
      MONITOR_CODE: '200',
      ALERTS_STATUS: 'OK',
      KEEPERS_STATUS: 'OK',
      KEEPERS: '8453=ok',
      KEEPERS_INFRA: '',
      RATE_LIMITED: rateLimited,
      GAS_CHAINS: '',
      GIT_COUNT: '0',
    },
  })
  return readFileSync(out, 'utf-8')
}

describe('daily-health-report: sources answering HTTP 429', () => {
  it('the token builder emits "id=ISO" per rate-limited source only, every character whitelisted', () => {
    const body = {
      healthy: false,
      sources: [
        { id: 'cowswap', status: 'degraded', rateLimitedSince: '2026-10-29T14:02:00.000Z' },
        { id: '1inch', status: 'active', rateLimitedSince: null },
        { id: 'evil\nid', status: 'degraded', rateLimitedSince: '2026-11-01T00:00:00.000Z<script>' },
      ],
    }
    expect(tokens(body)).toBe('cowswap=2026-10-29T14:02:00.000Z evilid=2026-11-01T00:00:00.000Zscript')
    expect(tokens('')).toBe('') // endpoint unreachable
    expect(tokens({ sources: [{ id: 'cowswap', status: 'active' }] })).toBe('') // an older route without the field
  })

  it('a rate-limited source ⇒ the [SOURCE] line as a ⚠️ row + an attention bullet + WARNING', () => {
    const md = report('cowswap=2026-10-29T14:02:00.000Z')
    expect(md).toContain('| Source rate limit (cowswap) | ⚠️ | [SOURCE] cowswap: rate-limited (429) since 2026-10-29T14:02:00.000Z |')
    expect(md).toContain('- [SOURCE] cowswap: rate-limited (429) since 2026-10-29T14:02:00.000Z — the source stays queried but degraded')
    expect(md).toContain('🟡 WARNING')
  })

  it('none ⇒ no row, still OK', () => {
    const md = report('')
    expect(md).not.toContain('Source rate limit')
    expect(md).toContain('🟢 OK')
  })
})
