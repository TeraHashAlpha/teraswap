import { describe, it, expect } from 'vitest'
import { decodeAbiParameters, getAddress, toHex, type Hex } from 'viem'
import { VELORA_DEFAULT_PARTNER } from './velora-partner'
import { AUGUSTUS_UNIV3_ARG_TYPES } from './calldata-recipient'
import {
  VELORA_UNIV3_ARB_DIRECT_CALLDATA,
  VELORA_UNIV3_ARB_FEE_ROUTED_CALLDATA,
} from './__fixtures__/velora-augustus-uniswapv3-arbitrum'

describe('VELORA_DEFAULT_PARTNER', () => {
  it('equals the partner (partnerAndFee >> 96, AugustusFees.sol:720-731) decoded from both captured calldatas', () => {
    for (const calldata of [VELORA_UNIV3_ARB_DIRECT_CALLDATA, VELORA_UNIV3_ARB_FEE_ROUTED_CALLDATA]) {
      const [, partnerAndFee] = decodeAbiParameters(AUGUSTUS_UNIV3_ARG_TYPES, `0x${calldata.slice(10)}` as Hex)
      // Checksummed on the decoded side, so strict equality also pins the literal's checksum.
      expect(getAddress(toHex(partnerAndFee >> 96n, { size: 20 }))).toBe(VELORA_DEFAULT_PARTNER)
    }
  })
})
