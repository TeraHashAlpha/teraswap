/**
 * [A71 M-2] The daily health report must never call the keepers OK while an ACTIVE chain's paused
 * state could not be read — that chain may be the paused one (INC-2026-10-30-001).
 *
 * Runs the workflow's OWN scripts, extracted verbatim from .github/workflows/daily-health-report.yml:
 * the monitor step's `keepers=` token builder (`node -e '…'`) and the compose step's report script
 * (the `compose-report.mjs` heredoc). Fixtures only — no network, no secrets.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const YML = readFileSync(resolve(process.cwd(), '.github/workflows/daily-health-report.yml'), 'utf-8')
const dir = mkdtempSync(join(tmpdir(), 'daily-report-keepers-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function tokenScript(): string {
  const m = YML.match(/keepers=\$\(node -e '([^']+)' "\$keepers_body"\)/)
  if (!m) throw new Error('keepers= token builder not found in daily-health-report.yml')
  return m[1]
}

function composeScript(): string {
  const open = "cat > /tmp/compose-report.mjs <<'NODE_EOF'\n"
  const start = YML.indexOf(open)
  const end = YML.indexOf('\n          NODE_EOF', start)
  if (start < 0 || end < 0) throw new Error('compose-report.mjs heredoc not found in daily-health-report.yml')
  return YML.slice(start + open.length, end)
    .split('\n')
    .map((l) => l.replace(/^ {10}/, ''))
    .join('\n')
}

/** The monitor step: /api/monitor/keepers body → the KEEPERS tokens. */
function tokens(body: unknown): string {
  return execFileSync(process.execPath, ['-e', tokenScript(), JSON.stringify(body)], { encoding: 'utf-8' })
}

/** [ADR-026] The monitor step's `keepers_infra=` token builder: /api/monitor/keepers body → "chainId=<n|unknown>" tokens. */
function infraTokenScript(): string {
  const m = YML.match(/keepers_infra=\$\(node -e '([^']+)' "\$keepers_body"\)/)
  if (!m) throw new Error('keepers_infra= token builder not found in daily-health-report.yml')
  return m[1]
}
function infraTokens(body: unknown): string {
  return execFileSync(process.execPath, ['-e', infraTokenScript(), JSON.stringify(body)], { encoding: 'utf-8' })
}

/** The compose step on an otherwise healthy production, with the given keeper inputs. */
function report(keepersStatus: string, keepers: string, keepersInfra = ''): string {
  const script = join(dir, 'compose-report.mjs')
  const out = join(dir, `report-${keepersStatus}-${keepers.replace(/[^a-z0-9]/gi, '_')}-${keepersInfra.replace(/[^a-z0-9]/gi, '_')}.md`)
  writeFileSync(script, composeScript())
  execFileSync(process.execPath, [script], {
    env: {
      NODE_ENV: 'test', // required by Next's ProcessEnv typing; the script does not read it
      PATH: process.env.PATH,
      OUT_PATH: out,
      REPORT_DATE: '2026-11-01',
      SITE_CODE: '200',
      SITE_TIME: '0.2',
      API_CODE: '200',
      API_TIME: '0.2',
      SSL_END: 'Jan  1 00:00:00 2027 GMT',
      SSL_DAYS: '60',
      MONITOR_CODE: '200',
      ALERTS_STATUS: 'OK',
      KEEPERS_STATUS: keepersStatus,
      KEEPERS: keepers,
      KEEPERS_INFRA: keepersInfra,
      GAS_CHAINS: '',
      GIT_COUNT: '0',
    },
  })
  return readFileSync(out, 'utf-8')
}

const OK_ROW = '| Keeper state (keeper_runtime_config) | ✅ |'

describe('[A71 M-2] daily-health-report: keeper state', () => {
  it('the token builder marks an unreadable ACTIVE chain "unreadable" and an inactive one "inactive"', () => {
    const body = {
      status: 'UNKNOWN',
      chains: [
        { chainId: 8453, active: true, readable: false, paused: null, pausedSince: null },
        { chainId: 42161, active: false, readable: false, paused: null, pausedSince: null },
        { chainId: 1, active: true, readable: true, paused: null, pausedSince: null },
      ],
    }
    expect(tokens(body)).toBe('8453=unreadable 42161=inactive 1=ok')
  })

  it('status OK (e.g. an older route deploy) but an active chain unreadable ⇒ ⚠️ UNKNOWN + WARNING, never ✅', () => {
    const md = report('OK', '8453=unreadable 42161=ok')
    expect(md).not.toContain(OK_ROW)
    expect(md).toContain('| Keeper state (keeper_runtime_config) | ⚠️ | UNKNOWN — the paused state of Base (8453) could not be read')
    expect(md).toContain('🟡 WARNING')
    expect(md).toContain('Keeper state: UNKNOWN — the paused state of Base (8453) could not be read')
  })

  it('status UNKNOWN from the route with an unreadable chain ⇒ the same ⚠️ row naming the chain', () => {
    const md = report('UNKNOWN', '8453=unreadable 42161=ok')
    expect(md).toContain('UNKNOWN — the paused state of Base (8453) could not be read')
    expect(md).toContain('🟡 WARNING')
  })

  it('every active chain readable (an inactive one may not be) ⇒ ✅; an unreachable endpoint ⇒ the generic ⚠️ row', () => {
    const ok = report('OK', '8453=ok 42161=inactive')
    expect(ok).toContain(`${OK_ROW} no keeper reports a pause (8453: ok, 42161: inactive) |`)
    expect(ok).toContain('🟢 OK')
    const unreachable = report('UNKNOWN', '')
    expect(unreachable).toContain('UNKNOWN — /api/monitor/keepers could not be read')
    expect(unreachable).toContain('🟡 WARNING')
  })
})

describe('[ADR-026] daily-health-report: orders with infra misses in the last 24 h', () => {
  const INFRA_ROW = '| Orders with infra misses (24 h) |'

  it('[A73 S-4] the token builder is tri-state: "chainId=<n>" when ok, "unknown" for a missing column, "error" for a failed read; every character whitelisted', () => {
    const body = {
      status: 'OK',
      chains: [
        { chainId: 8453, active: true, readable: true, paused: null, pausedSince: null, infraMissOrders24h: 3, infraMissStatus: 'ok' },
        { chainId: 42161, active: false, readable: true, paused: null, pausedSince: null, infraMissOrders24h: null, infraMissStatus: 'missing' },
        { chainId: 1, active: true, readable: true, paused: null, pausedSince: null, infraMissOrders24h: null, infraMissStatus: 'error' },
        { chainId: 10, active: true, readable: true, paused: null, pausedSince: null, infraMissOrders24h: '7\nmalicious', infraMissStatus: 'ok' },
      ],
    }
    expect(infraTokens(body)).toBe('8453=3 42161=unknown 1=error 10=error')
    expect(infraTokens({ status: 'OK', chains: [{ chainId: 8453 }] })).toBe('8453=unknown') // an older route deploy without the fields
    expect(infraTokens('')).toBe('')
  })

  it('[A73 S-4] a failed read ⇒ ⚠️ row + WARNING + attention bullet (never the quiet ℹ️ of a pending migration)', () => {
    const md = report('OK', '8453=ok 42161=inactive', '8453=error 42161=0')
    expect(md).toContain(`${INFRA_ROW} ⚠️ | Base: error, Arbitrum One: 0 — the infra-miss count could not be read for Base (Supabase query failed), so an outage's orders would go unreported |`)
    expect(md).toContain('🟡 WARNING')
    expect(md).toContain('Orders with infra misses: the 24 h count could not be read for Base (Supabase query failed)')
  })

  it('a chain with infra misses ⇒ ⚠️ row + WARNING + an attention bullet that says the orders were NOT counted', () => {
    const md = report('OK', '8453=ok 42161=inactive', '8453=3 42161=0')
    expect(md).toContain(`${INFRA_ROW} ⚠️ | Base: 3, Arbitrum One: 0 — misses caused by our infrastructure, NOT counted against the orders (ADR-026) |`)
    expect(md).toContain('🟡 WARNING')
    expect(md).toContain('3 order(s) on Base missed a cycle for an infrastructure reason in the last 24 h (ADR-026: not counted against them)')
  })

  it('all zero ⇒ ✅ row, no warning; all unknown ⇒ ℹ️ row naming the migration, no warning; no tokens ⇒ no row', () => {
    const ok = report('OK', '8453=ok 42161=inactive', '8453=0 42161=0')
    expect(ok).toContain(`${INFRA_ROW} ✅ | Base: 0, Arbitrum One: 0 |`)
    expect(ok).toContain('🟢 OK')
    const unknown = report('OK', '8453=ok 42161=inactive', '8453=unknown 42161=unknown')
    expect(unknown).toContain(`${INFRA_ROW} ℹ️ | unknown — migration 20261104120000_orders_infra_miss.sql not applied (or Supabase unreadable) |`)
    expect(unknown).toContain('🟢 OK')
    const none = report('OK', '8453=ok 42161=inactive', '')
    expect(none).not.toContain(INFRA_ROW)
  })
})
