/**
 * [fix/catalog-refresh-drops-untrusted] The workflow is wired to the decision module: the PR body opens
 * with the removals section, a passing chain closes its failure issue, the alert uses the exact-title
 * CLI, and the guard test is still the gate. Text-level checks on the YAML (no network, no gh).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const wf = readFileSync(join(root, '.github', 'workflows', 'token-catalog-refresh.yml'), 'utf8')

/** The shell text of the step whose `name:` line contains `needle`. */
function stepBody(needle: string): string {
  const start = wf.indexOf(needle)
  expect(start, `step "${needle}" not found`).toBeGreaterThan(-1)
  const next = wf.indexOf('\n      - name:', start + 1)
  return wf.slice(start, next === -1 ? undefined : next)
}

describe('token-catalog-refresh.yml wiring', () => {
  it('the gate still runs the unmodified guard test file', () => {
    expect(stepBody('Gate the regenerated catalog')).toContain('src/lib/chains/catalog-address-guard.test.ts')
  })

  it('tokens:sync gets the report dir the later steps read', () => {
    expect(stepBody('Rebuild token catalog')).toContain('TOKENS_SYNC_REPORT_DIR: catalog-refresh-report')
  })

  it('the PR body opens with the decision sections, and a missing file stops the PR', () => {
    const pr = stepBody('Open a PR when this chain')
    const sections = pr.indexOf('cat "$SECTIONS_FILE"')
    const intro = pr.indexOf('Automated \\`npm run tokens:sync\\` refresh')
    expect(sections).toBeGreaterThan(-1)
    expect(sections).toBeLessThan(intro)
    expect(pr).toContain('catalog-refresh-report/pr-body.${CHAIN}.md')
    expect(pr).toMatch(/\[ ! -s "\$SECTIONS_FILE" \].*exit 1/)
  })

  it('a passing run closes the chain\'s failure issue; it runs before the failure alert', () => {
    const close = stepBody('Close this chain\'s open failure issue')
    expect(close).toContain('if: success()')
    expect(close).toContain('refresh-issue.ts close "$CHAIN" "$RUN_URL"')
    expect(wf.indexOf('Close this chain\'s open failure issue')).toBeLessThan(wf.indexOf('Loud failure alert'))
  })

  it('the failure alert goes through the exact-title CLI, not the fuzzy search', () => {
    const alert = stepBody('Loud failure alert')
    expect(alert).toContain('if: failure()')
    expect(alert).toContain('refresh-issue.ts alert')
    expect(alert).not.toContain('--search')
    expect(alert).toContain('blocked.${{ matrix.chain }}.txt')
  })

  it('rule D: the auto-merge step hands the eligibility script this chain\'s decision file', () => {
    const am = stepBody('Auto-merge when eligible')
    expect(am).toContain('--decision-file "catalog-refresh-report/decision.${CHAIN}.json"')
  })

  it('rule A: a passing run comments on / creates / closes the chain\'s ONE held-back issue from the decision file', () => {
    const held = stepBody('Held-back sources issue')
    expect(held).toContain('if: success()')
    expect(held).toContain('refresh-issue.ts held "$CHAIN" "catalog-refresh-report/decision.${CHAIN}.json" "$RUN_URL"')
    expect(held).not.toContain('--search')
    expect(wf.indexOf('Held-back sources issue')).toBeLessThan(wf.indexOf('Loud failure alert'))
  })

  it('the report dir is gitignored (decision artifacts are never committed)', () => {
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\/?catalog-refresh-report\/?$/m)
  })
})
