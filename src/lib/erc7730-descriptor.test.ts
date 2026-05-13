/**
 * [P106] Selector-drift guard for the FeeCollector V2 ERC-7730 descriptor.
 *
 * The descriptor at contracts/clear-signing/erc7730-feecollector-v2.json
 * maps each function signature to a human-readable display block for
 * hardware-wallet clear signing. If the FeeCollector V2 ABI ever drifts
 * from what the descriptor describes, the descriptor would silently keep
 * claiming the old shape — wallets would still render fields, just for
 * the wrong contract. This test pins the on-chain selectors and the
 * deployment address so any drift fails CI before it ships to wallets.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256, toBytes } from 'viem'
import { FEE_COLLECTOR_ABI } from '@/lib/constants'

interface AbiFunction {
  type: string
  name?: string
  inputs?: Array<{ name: string; type: string }>
}

interface Erc7730Field {
  path: string
  label?: string
  format?: string
  /** [P108 v2] Per-field visibility — `"never"` replaces the v1
   *  top-level `excluded` array. */
  visible?: 'never'
  params?: Record<string, unknown>
}

interface Erc7730Descriptor {
  context: {
    contract: {
      deployments: Array<{ chainId: number; address: string }>
      abi: AbiFunction[]
    }
  }
  display: {
    formats: Record<
      string,
      {
        intent: string
        fields: Erc7730Field[]
      }
    >
  }
}

const DESCRIPTOR_PATH = join(
  __dirname,
  '..',
  '..',
  'contracts',
  'clear-signing',
  'erc7730-feecollector-v2.json',
)

const descriptor: Erc7730Descriptor = JSON.parse(
  readFileSync(DESCRIPTOR_PATH, 'utf-8'),
)

/** Build the canonical signature string `name(type1,type2,...)`. */
function canonicalSig(fn: AbiFunction): string {
  const types = (fn.inputs ?? []).map((i) => i.type).join(',')
  return `${fn.name}(${types})`
}

function selectorOf(sig: string): `0x${string}` {
  return keccak256(toBytes(sig)).slice(0, 10) as `0x${string}`
}

describe('ERC-7730 FeeCollector V2 descriptor', () => {
  const abiFns = descriptor.context.contract.abi.filter((e) => e.type === 'function')

  it('targets the deployed FeeCollector V2 on Ethereum mainnet', () => {
    expect(descriptor.context.contract.deployments).toHaveLength(1)
    const dep = descriptor.context.contract.deployments[0]
    expect(dep.chainId).toBe(1)
    expect(dep.address.toLowerCase()).toBe(
      '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459'.toLowerCase(),
    )
  })

  it('describes exactly the 2 user-facing swap functions', () => {
    const names = abiFns.map((f) => f.name).sort()
    expect(names).toEqual(['swapETHWithFee', 'swapTokenWithFee'])
  })

  it('every described function has a display format keyed by its canonical signature', () => {
    for (const fn of abiFns) {
      const sig = canonicalSig(fn)
      expect(
        descriptor.display.formats[sig],
        `missing display.formats["${sig}"]`,
      ).toBeDefined()
    }
  })

  // [P108] v2 schema replaces the top-level `excluded` array with a
  // per-field `visible: "never"`. routerData is opaque adapter calldata
  // — never something a user can verify on a hardware-wallet screen,
  // so every format must include a routerData field marked hidden.
  it('routerData is present and hidden (visible: "never") on both formats', () => {
    for (const [sig, format] of Object.entries(descriptor.display.formats)) {
      const routerDataField = format.fields.find((f) => f.path === 'routerData')
      expect(
        routerDataField,
        `format ${sig} is missing a routerData field`,
      ).toBeDefined()
      expect(
        routerDataField!.visible,
        `routerData on ${sig} must be visible: "never"`,
      ).toBe('never')
    }
  })

  // Pin the actual on-chain selectors. If anyone edits the descriptor and
  // accidentally changes the function signature (e.g. drops a param,
  // reorders types), these constants will break the test before drift
  // ships to wallets.
  const EXPECTED_SELECTORS: Record<string, `0x${string}`> = {
    'swapTokenWithFee(address,uint256,address,bytes,address,uint256)': '0x7f7663d4',
    'swapETHWithFee(address,bytes,address,uint256)': '0x7739563c',
  }

  it.each(Object.entries(EXPECTED_SELECTORS))(
    'descriptor signature %s has the pinned 4-byte selector %s',
    (sig, expected) => {
      // The signature is present in display.formats — confirms the
      // descriptor still claims this exact function shape.
      expect(descriptor.display.formats[sig]).toBeDefined()
      // The computed selector matches the on-chain one.
      expect(selectorOf(sig)).toBe(expected)
    },
  )

  it('descriptor ABI agrees with the frontend FEE_COLLECTOR_ABI on every function signature', () => {
    const frontendSigs = new Set(
      FEE_COLLECTOR_ABI
        .filter((e) => e.type === 'function')
        .map((e) => canonicalSig(e as unknown as AbiFunction)),
    )
    for (const fn of abiFns) {
      expect(
        frontendSigs.has(canonicalSig(fn)),
        `descriptor function ${canonicalSig(fn)} not found in FEE_COLLECTOR_ABI`,
      ).toBe(true)
    }
  })
})
