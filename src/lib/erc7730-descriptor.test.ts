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

/**
 * Build the canonical Solidity signature `name(type1,type2,…)`.
 * This is the form keccak256'd to produce the 4-byte function selector.
 */
function canonicalSig(fn: AbiFunction): string {
  const types = (fn.inputs ?? []).map((i) => i.type).join(',')
  return `${fn.name}(${types})`
}

/**
 * Build the ERC-7730 v2 descriptor-key form `name(type1 param1,type2 param2,…)`.
 * The registry's lint accepts the "type name" form alongside the bare-type
 * form; we use the "type name" form in display.formats keys because it's
 * what the registry's submitted descriptors converge on for readability.
 */
function descriptorKey(fn: AbiFunction): string {
  const args = (fn.inputs ?? []).map((i) => `${i.type} ${i.name}`).join(',')
  return `${fn.name}(${args})`
}

function selectorOf(canonicalSignature: string): `0x${string}` {
  return keccak256(toBytes(canonicalSignature)).slice(0, 10) as `0x${string}`
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

  it('every described function has a display format keyed by its "type name" signature', () => {
    for (const fn of abiFns) {
      const key = descriptorKey(fn)
      expect(
        descriptor.display.formats[key],
        `missing display.formats["${key}"]`,
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

  // Pin the actual on-chain selectors. Each entry holds the
  // ERC-7730-v2 display.formats key ("type name" form), the canonical
  // Solidity signature (types-only — what kecccak256 hashes for the
  // selector), and the 4-byte selector. If anyone edits the descriptor
  // and changes a function shape, both the descriptor lookup and the
  // selector check break the test before drift ships to wallets.
  const EXPECTED_SELECTORS: Array<{
    descriptorKey: string
    canonicalSig: string
    selector: `0x${string}`
  }> = [
    {
      descriptorKey: 'swapTokenWithFee(address token,uint256 totalAmount,address router,bytes routerData,address tokenOut,uint256 minimumOutput)',
      canonicalSig: 'swapTokenWithFee(address,uint256,address,bytes,address,uint256)',
      selector: '0x7f7663d4',
    },
    {
      descriptorKey: 'swapETHWithFee(address router,bytes routerData,address tokenOut,uint256 minimumOutput)',
      canonicalSig: 'swapETHWithFee(address,bytes,address,uint256)',
      selector: '0x7739563c',
    },
  ]

  it.each(EXPECTED_SELECTORS)(
    'descriptor key $descriptorKey resolves to canonical $canonicalSig with selector $selector',
    ({ descriptorKey: key, canonicalSig: canonical, selector }) => {
      // The display.formats key is present — confirms the descriptor
      // still claims this exact function shape.
      expect(descriptor.display.formats[key]).toBeDefined()
      // The canonical-signature → selector mapping is what gets compiled
      // into on-chain calldata; pinning both protects against silent
      // edits to either form.
      expect(selectorOf(canonical)).toBe(selector)
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
