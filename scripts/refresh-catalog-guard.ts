/**
 * refresh-catalog-guard — regenerates the catalog-address-guard verdict cache.
 *
 *   npx tsx scripts/refresh-catalog-guard.ts
 *
 * For EVERY token in the curated catalog (src/lib/tokens.ts + src/lib/chains/tokens.ts,
 * chains 1 + 8453) it records the guard signals into a committed, DETERMINISTIC fixture
 * (src/lib/chains/catalog-guard.trust.json) that the vitest gate reads WITHOUT any network:
 *
 *   • inTrustedList  — address present in CoinGecko's per-chain token list (by address).
 *   • hasBytecode    — on-chain getCode(address) is non-empty (catches DEAD addresses).
 *   • transferable   — read-only eth_call of transfer(0x…dead, 0) does NOT revert
 *                      (advisory: some legit tokens — e.g. USDT — revert this probe).
 *   • onchainSymbol / decimals — identity + FATAL decimals cross-check inputs.
 *
 * [CHORE-TOKEN-CATALOG-PIPELINE] The collection logic lives in the SHARED module
 * scripts/token-catalog/lib/verdicts.ts so the catalog build pipeline routes its candidate
 * tokens through the SAME probes (reuse, not reimplementation). This script remains the
 * standalone refresher: network I/O here, ALL failures NON-FATAL (null = "unknown / don't
 * fail on infra"). Re-run whenever the catalog changes, then commit the updated fixture.
 * The gate (catalog-address-guard.test.ts) NEVER hits the network.
 */
import { getFullCatalog } from '@/lib/chains/tokens'
import { NATIVE_ETH } from '@/lib/constants'
import { GUARD_CHAINS, collectVerdicts, writeTrustFixture, type TokenIdentity } from './token-catalog/lib/verdicts'

async function run() {
  const tokens: TokenIdentity[] = []
  for (const chainId of GUARD_CHAINS) {
    const cat = getFullCatalog(chainId).filter((t) => t.address.toLowerCase() !== NATIVE_ETH.toLowerCase())
    tokens.push(...cat.map((t) => ({ chainId, address: t.address, symbol: t.symbol })))
  }
  const verdicts = await collectVerdicts(tokens)
  const { file, count } = writeTrustFixture(verdicts, GUARD_CHAINS)
  const dead = verdicts.filter((v) => v.hasBytecode === false)
  const notInList = verdicts.filter((v) => v.inTrustedList === false)
  const nonTransfer = verdicts.filter((v) => v.transferable === false)
  console.error(`\nwrote ${file}: ${count} verdicts`)
  console.error(`  hasBytecode=false (DEAD): ${dead.length}  -> ${dead.map((v) => v.symbol).join(', ') || 'none'}`)
  console.error(`  inTrustedList=false: ${notInList.length}`)
  console.error(`  transferable=false (advisory): ${nonTransfer.length}`)
}
run()
