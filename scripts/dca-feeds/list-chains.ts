#!/usr/bin/env tsx
/**
 * [feat/dca-feed-candidates-weekly] Prints, as a JSON array on stdout and nothing else, the chain keys the weekly
 * candidates job fans out over (`--chain <key>` of candidates.ts). Feeds the workflow's matrix (`fromJson(...)`).
 *
 * Not a second hand-maintained chain list: it is the chain REGISTRY's supported ids (the source the token-catalog
 * refresh matrix uses too) narrowed to the chains the DCA feed scripts know (scripts/dca-feeds/lib.ts CHAINS: the
 * ones with an OrderExecutor V3 row in docs/DEPLOYMENTS.md). Ethereum mainnet is in the registry but has no DCA
 * executor, so it never appears; a chain removed from the registry drops out here instead of failing a job.
 */
import { getSupportedChainIds } from '@/lib/chains/registry'
import { CHAINS } from './lib'

const supported = new Set(getSupportedChainIds())
process.stdout.write(JSON.stringify(Object.entries(CHAINS).filter(([, chain]) => supported.has(chain.id)).map(([key]) => key)))
