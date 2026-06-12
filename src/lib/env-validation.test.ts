// @vitest-environment node
/**
 * [CHORE-POLISH-3 P4 / E3-I-02] env-validation — ALCHEMY_API_KEY registration.
 *
 * The single ALCHEMY_API_KEY serves BOTH eth-mainnet and base-mainnet since
 * E-3 (portfolio Base discovery). It was read by the tokens route but never
 * registered here, so a missing key produced no startup signal — and the
 * app-scope requirement (key must cover both networks) lived nowhere. These
 * tests pin the warning-only rule (validation must NOT hard-fail on it:
 * the multicall fallback keeps the Portfolio tab working without a key).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validateEnv } from './env-validation'

const ORIGINAL = process.env.ALCHEMY_API_KEY

beforeEach(() => {
  delete process.env.ALCHEMY_API_KEY
})

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ALCHEMY_API_KEY
  else process.env.ALCHEMY_API_KEY = ORIGINAL
})

describe('env-validation — ALCHEMY_API_KEY [CHORE-POLISH-3 P4]', () => {
  it('warns (never errors) when ALCHEMY_API_KEY is unset', () => {
    const { errors, warnings } = validateEnv()
    expect(warnings.some((w) => w.includes('ALCHEMY_API_KEY'))).toBe(true)
    expect(errors.some((e) => e.includes('ALCHEMY_API_KEY'))).toBe(false)
  })

  it('the warning states the app-scope requirement (eth-mainnet AND base-mainnet)', () => {
    const { warnings } = validateEnv()
    const warning = warnings.find((w) => w.includes('ALCHEMY_API_KEY'))
    expect(warning).toBeTruthy()
    expect(warning).toMatch(/eth-mainnet/i)
    expect(warning).toMatch(/base-mainnet/i)
  })

  it('does not warn when the key is set', () => {
    process.env.ALCHEMY_API_KEY = 'test-key'
    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes('ALCHEMY_API_KEY'))).toBe(false)
  })
})
