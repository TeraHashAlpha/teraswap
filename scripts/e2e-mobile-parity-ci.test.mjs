/**
 * [L-8, A75] The v2 mobile-parity Playwright suite (src/ui/v2/__tests__/mobile/) was never wired into
 * .github/workflows/e2e.yml — the config's own doc comment said so, and the Auditor flagged it as not in CI.
 * This pins that a job actually runs it, after a build with UI_V2_ENABLED=true (the suite's own documented
 * reproduction steps).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflow = load(readFileSync(join(process.cwd(), '.github/workflows/e2e.yml'), 'utf8'))
const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
const runCommands = allSteps.map((step) => step.run).filter(Boolean)

describe('e2e.yml: v2 mobile-parity suite', () => {
  it('runs src/ui/v2/__tests__/mobile/playwright.config.ts', () => {
    expect(runCommands.some((cmd) => cmd.includes('src/ui/v2/__tests__/mobile/playwright.config.ts'))).toBe(true)
  })

  it('builds the app with UI_V2_ENABLED=true before that step runs', () => {
    const suiteStep = allSteps.find((step) => step.run?.includes('src/ui/v2/__tests__/mobile/playwright.config.ts'))
    const job = Object.values(workflow.jobs).find((j) => j.steps?.includes(suiteStep))
    const stepIndex = job.steps.indexOf(suiteStep)
    const buildStep = job.steps.slice(0, stepIndex).find((step) => step.run?.includes('npm run build'))
    expect(buildStep).toBeTruthy()
    expect(buildStep.env?.UI_V2_ENABLED).toBe('true')
  })

  it('installs Playwright Chromium before any suite runs in its job', () => {
    const suiteStep = allSteps.find((step) => step.run?.includes('src/ui/v2/__tests__/mobile/playwright.config.ts'))
    const job = Object.values(workflow.jobs).find((j) => j.steps?.includes(suiteStep))
    const stepIndex = job.steps.indexOf(suiteStep)
    expect(job.steps.slice(0, stepIndex).some((step) => step.run?.includes('playwright install'))).toBe(true)
  })

  // [L-8, A75b] The job was wired but RED on the PR's own head: the build step set only UI_V2_ENABLED + the WalletConnect id,
  // while the suite's `dca` route needs the same PUBLIC build env as the Vercel Preview build (feat/ui-v2-landing feedback:
  // "for the DCA gate set NEXT_PUBLIC_DCA_ENABLED, NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE, NEXT_PUBLIC_BASE_FEE_COLLECTOR").
  // Unset => no chain is DCA-live => the plain pane => the dca route times out (CI: 42 pass / 5 fail; Preview-env rig: 47/47).
  describe('build env matches the Vercel Preview build (public values only)', () => {
    const suiteStep = allSteps.find((step) => step.run?.includes('src/ui/v2/__tests__/mobile/playwright.config.ts'))
    const job = Object.values(workflow.jobs).find((j) => j.steps?.includes(suiteStep))
    const buildStep = job.steps.slice(0, job.steps.indexOf(suiteStep)).find((step) => step.run?.includes('npm run build'))
    const ADDRESS_ENV = [
      'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE',
      'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM',
      'NEXT_PUBLIC_BASE_FEE_COLLECTOR',
      'NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR',
    ]

    it('sets NEXT_PUBLIC_DCA_ENABLED=true', () => {
      expect(buildStep.env?.NEXT_PUBLIC_DCA_ENABLED).toBe('true')
    })

    it.each(ADDRESS_ENV)('%s comes from the repository variable of the same name', (name) => {
      expect(buildStep.env?.[name]).toBe(`\${{ vars.${name} }}`)
    })

    it('types no 20-byte hex address anywhere in the workflow (names only; values live in repository variables)', () => {
      expect(readFileSync(join(process.cwd(), '.github/workflows/e2e.yml'), 'utf8')).not.toMatch(/0x[0-9a-fA-F]{40}/)
    })
  })
})
