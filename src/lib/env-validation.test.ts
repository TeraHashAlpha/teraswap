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
import { DISABLED_SOURCES } from './constants'

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

// [dead-sources-are-loud, 2026-09] ZEROX_API_KEY required-when-enabled.
//
// ZEROX_API_KEY was OPTIONAL — a missing/expired key never failed a build or
// boot, so 0x 401'd quietly on every quote for weeks (measured 2026-09-02).
// It must now fail validation whenever '0x' is enabled (not in
// DISABLED_SOURCES) and the key is absent.
describe('env-validation — ZEROX_API_KEY required-when-enabled [dead-sources-are-loud]', () => {
  const ORIGINAL_ZEROX_KEY = process.env.ZEROX_API_KEY
  const ORIGINAL_0X_DISABLED = DISABLED_SOURCES['0x']

  beforeEach(() => {
    delete process.env.ZEROX_API_KEY
    delete DISABLED_SOURCES['0x']
  })

  afterEach(() => {
    if (ORIGINAL_ZEROX_KEY === undefined) delete process.env.ZEROX_API_KEY
    else process.env.ZEROX_API_KEY = ORIGINAL_ZEROX_KEY
    if (ORIGINAL_0X_DISABLED === undefined) delete DISABLED_SOURCES['0x']
    else DISABLED_SOURCES['0x'] = ORIGINAL_0X_DISABLED
  })

  it('fails, naming "0x" and ZEROX_API_KEY, when the key is absent and 0x is enabled', () => {
    const { valid, errors } = validateEnv()
    expect(valid).toBe(false)
    const err = errors.find((e) => e.includes('ZEROX_API_KEY'))
    expect(err).toBeTruthy()
    expect(err).toContain('0x')
  })

  it('passes the ZEROX_API_KEY check when 0x is in DISABLED_SOURCES', () => {
    DISABLED_SOURCES['0x'] = 'test: temporarily disabled'
    const { errors } = validateEnv()
    expect(errors.some((e) => e.includes('ZEROX_API_KEY'))).toBe(false)
  })

  it('passes when the key is set and 0x is enabled', () => {
    process.env.ZEROX_API_KEY = 'a-real-key'
    const { errors } = validateEnv()
    expect(errors.some((e) => e.includes('ZEROX_API_KEY'))).toBe(false)
  })
})

// [CHORE-2026-09-03 / INC-2026-09-03-001] openocean/bebop disabled — no key
// may become required for either. openocean has no key variable at all;
// BEBOP_API_KEY was never a RULES entry. Both must stay that way now that
// the sources are disabled, and ZEROX_API_KEY (0x stays enabled) must keep
// failing without it, proving disabling these two didn't loosen anything.
describe('env-validation — disabled sources require no keys [CHORE-2026-09-03]', () => {
  const ORIGINAL_ZEROX_KEY = process.env.ZEROX_API_KEY
  const ORIGINAL_BEBOP_KEY = process.env.BEBOP_API_KEY

  beforeEach(() => {
    delete process.env.ZEROX_API_KEY
    delete process.env.BEBOP_API_KEY
  })

  afterEach(() => {
    if (ORIGINAL_ZEROX_KEY === undefined) delete process.env.ZEROX_API_KEY
    else process.env.ZEROX_API_KEY = ORIGINAL_ZEROX_KEY
    if (ORIGINAL_BEBOP_KEY === undefined) delete process.env.BEBOP_API_KEY
    else process.env.BEBOP_API_KEY = ORIGINAL_BEBOP_KEY
  })

  it('bebop and openocean are both in DISABLED_SOURCES', () => {
    expect(DISABLED_SOURCES.bebop).toBeTruthy()
    expect(DISABLED_SOURCES.openocean).toBeTruthy()
  })

  it('passes with neither BEBOP_API_KEY nor any OpenOcean var set', () => {
    process.env.ZEROX_API_KEY = 'a-real-key' // keep 0x's own gate satisfied
    const { errors } = validateEnv()
    expect(errors.some((e) => e.includes('BEBOP'))).toBe(false)
    expect(errors.some((e) => e.toLowerCase().includes('openocean'))).toBe(false)
  })

  it('still fails without ZEROX_API_KEY — 0x stays enabled', () => {
    const { valid, errors } = validateEnv()
    expect(valid).toBe(false)
    expect(errors.some((e) => e.includes('ZEROX_API_KEY'))).toBe(true)
  })
})
