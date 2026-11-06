/**
 * [fix/user-ip-privacy] The third-party-host capture (e2e/third-party-hosts) is the lock on "this site never sends the
 * visitor's IP to a third party". A lock that is not in CI is a note. This pins that .github/workflows/e2e.yml runs it,
 * against a production build made in the same job, and that the bundle check is given exactly the marker values that
 * build was given — so the "not in any client chunk" assertion cannot quietly become a search for strings that were
 * never there.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const CONFIG = 'e2e/third-party-hosts/playwright.config.ts'
const workflow = load(readFileSync(join(process.cwd(), '.github/workflows/e2e.yml'), 'utf8'))
const jobs = Object.entries(workflow.jobs)
const [jobName, job] = jobs.find(([, j]) => (j.steps ?? []).some((s) => s.run?.includes(CONFIG))) ?? []
const steps = job?.steps ?? []
const runStep = steps.find((s) => s.run?.includes(CONFIG))
const before = steps.slice(0, steps.indexOf(runStep))
const buildStep = before.find((s) => s.run?.includes('npm run build'))

describe('e2e.yml: third-party-host capture', () => {
  it('a job runs e2e/third-party-hosts with Playwright', () => {
    expect(jobName).toBe('third-party-hosts')
    expect(runStep.run).toBe(`npx playwright test --config ${CONFIG}`)
  })

  it('runs on pull requests to main and pushes to main (the workflow triggers)', () => {
    const on = workflow.on ?? workflow.true // js-yaml reads a bare `on:` key as boolean true
    expect(on.pull_request.branches).toContain('main')
    expect(on.push.branches).toContain('main')
  })

  it('installs deps and Playwright Chromium, then builds, before the capture', () => {
    expect(before.some((s) => s.run === 'npm ci')).toBe(true)
    expect(before.some((s) => s.run?.includes('playwright install') && s.run.includes('chromium'))).toBe(true)
    expect(buildStep).toBeTruthy()
  })

  it('is not allowed to fail quietly (no continue-on-error, no `|| true`)', () => {
    expect(job['continue-on-error']).toBeUndefined()
    for (const step of steps) {
      expect(step['continue-on-error']).toBeUndefined()
      expect(step.run ?? '').not.toMatch(/\|\|\s*true/)
    }
  })

  it('does not bypass the CSP or pre-start servers that would hide the real config', () => {
    const config = readFileSync(join(process.cwd(), CONFIG), 'utf8')
    expect(config).toMatch(/bypassCSP: false/)
    expect(config).not.toMatch(/bypassCSP: true/)
    expect(runStep.env?.CAPTURE_V1_URL).toBeUndefined()
    expect(runStep.env?.CAPTURE_V2_URL).toBeUndefined()
  })

  describe('bundle markers', () => {
    const MARKER_ENV = ['NEXT_PUBLIC_BASE_RPC_URL', 'NEXT_PUBLIC_ARBITRUM_RPC_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SENTRY_DSN']
    const markers = (runStep.env?.CAPTURE_BUNDLE_MARKERS ?? '').split(',').filter(Boolean)

    it.each(MARKER_ENV)('the build is given a marker value for %s', (name) => {
      expect(typeof buildStep.env?.[name]).toBe('string')
      expect(buildStep.env[name].length).toBeGreaterThan(20)
    })

    it('every marker the capture searches for is a substring of a value the build was given', () => {
      expect(markers.length).toBeGreaterThanOrEqual(MARKER_ENV.length)
      const given = MARKER_ENV.map((name) => buildStep.env[name])
      for (const marker of markers) {
        expect([marker, given.some((value) => value.includes(marker))]).toEqual([marker, true])
      }
    })

    it('every marker env value is covered by at least one searched marker', () => {
      for (const name of MARKER_ENV) {
        expect([name, markers.some((marker) => buildStep.env[name].includes(marker))]).toEqual([name, true])
      }
    })

    it('markers are distinctive (long, and not a real provider host)', () => {
      for (const marker of markers) {
        expect(marker.length).toBeGreaterThanOrEqual(20)
        expect(marker).not.toMatch(/alchemy|infura|llamarpc|ankr|publicnode/)
      }
    })
  })

  it('types no 20-byte hex address in the job (public addresses come from repository variables, names only)', () => {
    expect(JSON.stringify(job)).not.toMatch(/0x[0-9a-fA-F]{40}/)
    for (const name of ['NEXT_PUBLIC_BASE_FEE_COLLECTOR', 'NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR']) {
      expect(buildStep.env[name]).toBe(`\${{ vars.${name} }}`)
    }
  })
})
