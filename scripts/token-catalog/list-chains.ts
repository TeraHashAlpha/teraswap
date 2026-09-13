#!/usr/bin/env tsx
/**
 * [fix/token-sync-cron-landing] Prints the chain registry's supported chain ids as a JSON
 * array on stdout — nothing else. Feeds the token-catalog-refresh cron's matrix
 * (`fromJson(...)`) so the workflow's per-chain fan-out has no hand-maintained chain list of
 * its own to fall behind the registry (the original bug this branch fixes).
 */
import { getSupportedChainIds } from '@/lib/chains/registry'

process.stdout.write(JSON.stringify(getSupportedChainIds()))
