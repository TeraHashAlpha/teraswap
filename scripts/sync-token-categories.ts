#!/usr/bin/env tsx
/**
 * Sync token categories from CoinGecko API.
 * Run manually: npm run tokens:sync
 *
 * WARNING: Makes ~85 API calls at 25 req/min (about 3.5 min).
 * Free tier: 30 req/min, 10k/month. Do NOT run in CI.
 */

// TODO: Implement CoinGecko sync in a future sprint.
// For now, categories are manually assigned based on section comments.
// See scripts/token-category-overrides.ts for manual overrides.

console.log('Token category sync not yet implemented.')
console.log('Categories are currently assigned manually in src/lib/tokens.ts')
process.exit(0)
